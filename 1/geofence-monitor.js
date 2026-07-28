(function () {
  "use strict";

  var apiRef = null;
  var timer = null;
  var monitoring = false;
  var devices = [];
  var groups = [];
  var zones = [];
  var latestRows = [];
  var fleetMap = null;
  var zoneLayer = null;
  var vehicleLayer = null;
  var eventsBound = false;

  function byId(id) { return document.getElementById(id); }
  function text(id, value) { byId(id).textContent = value; }
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function apiCall(method, params) {
    return new Promise(function (resolve, reject) {
      apiRef.call(method, params || {}, resolve, reject);
    });
  }
  function apiMultiCall(calls) {
    return new Promise(function (resolve, reject) {
      apiRef.multiCall(calls, resolve, reject);
    });
  }
  function showMessage(message, isError) {
    var el = byId("message");
    el.textContent = message || "";
    el.className = "message" + (isError ? " error" : "");
  }
  function errorText(error) {
    if (!error) return "Unknown error";
    return error.message || (error.error && error.error.message) || String(error);
  }
  function showPolicyResult(message, type) {
    var el = byId("policy-result");
    el.textContent = message || "";
    el.className = "policy-result" + (type ? " " + type : "");
  }
  function policySchedule() {
    var mode = byId("policy-schedule").value;
    return {
      mode: mode,
      startTime: mode === "FullTime" ? null : byId("policy-start-time").value,
      endTime: mode === "FullTime" ? null : byId("policy-end-time").value,
      crossesMidnight: mode === "FullTime" ? false : byId("policy-time-crosses-midnight").value === "true"
    };
  }
  function notificationSettings() {
    var notifyDriver = byId("notify-driver").checked;
    var notifyBackOffice = byId("notify-back-office").checked;
    return {
      enabled: notifyDriver || notifyBackOffice,
      notifyAssignedDriver: notifyDriver,
      backOfficeEmails: notifyBackOffice
        ? byId("back-office-emails").value.split(",").map(function (item) { return item.trim(); }).filter(Boolean)
        : [],
      includeLocationLink: byId("include-location-link").checked,
      attachMapImage: byId("attach-map-image").checked,
      cooldownMinutes: Number(byId("notification-cooldown").value),
      webhookUrl: byId("notification-webhook-url").value.trim()
    };
  }
  function timeSpan(value) {
    return value + ":00";
  }
  function workTimeDetails(startTime, endTime, crossesMidnight) {
    var details = [];
    for (var day = 0; day < 7; day += 1) {
      if (crossesMidnight) {
        details.push({ dayOfWeek: day, fromTime: timeSpan(startTime), toTime: "23:59:59" });
        details.push({ dayOfWeek: day, fromTime: "00:00:00", toTime: timeSpan(endTime) });
      } else {
        details.push({ dayOfWeek: day, fromTime: timeSpan(startTime), toTime: timeSpan(endTime) });
      }
    }
    return details;
  }
  async function createPolicyWorkTime(name, schedule) {
    if (schedule.mode === "FullTime") return null;
    var workTimeId = await apiCall("Add", {
      typeName: "WorkTime",
      entity: {
        name: (name + " hours").slice(0, 50),
        comment: "Created by Geofence Policy Monitor",
        details: workTimeDetails(schedule.startTime, schedule.endTime, schedule.crossesMidnight)
      }
    });
    return workTimeId;
  }
  function buildRuleCondition(trigger, zoneId, schedule, workTimeId) {
    var zoneCondition;
    if (trigger === "FullTimeUse") {
      zoneCondition = {
        conditionType: "And",
        children: [
          { conditionType: "InsideArea", zone: { id: zoneId } },
          { conditionType: "Ignition", value: 1 }
        ]
      };
    } else {
      zoneCondition = { conditionType: trigger, zone: { id: zoneId } };
    }
    if (!workTimeId) return zoneCondition;
    return {
      conditionType: "And",
      children: [
        zoneCondition,
        {
          conditionType: schedule.mode === "RestrictedWindow" ? "RuleWorkHours" : "AfterRuleWorkHours",
          workTime: { id: workTimeId }
        }
      ]
    };
  }
  async function createNativeEmailDistribution(name, ruleId, emailAddresses) {
    if (!emailAddresses.length) return null;
    return apiCall("Add", {
      typeName: "DistributionList",
      entity: {
        name: (name + " email alerts").slice(0, 50),
        rules: [{ id: ruleId }],
        recipients: emailAddresses.map(function (address) {
          return { recipientType: "Email", address: address };
        })
      }
    });
  }
  async function registerPolicyDelivery(payload, webhookUrl) {
    var response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error("Notification service returned HTTP " + response.status);
    }
  }
  function zoneCoordinates(zone) {
    return (zone.points || []).map(function (point) {
      var lon = Number(point.x);
      var lat = Number(point.y);
      return { lat: lat, lon: lon };
    }).filter(function (point) {
      return Number.isFinite(point.lat) && Number.isFinite(point.lon);
    });
  }
  function isInsidePolygon(latitude, longitude, polygon) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || polygon.length < 3) return null;
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var xi = polygon[i].lon;
      var yi = polygon[i].lat;
      var xj = polygon[j].lon;
      var yj = polygon[j].lat;
      var crosses = ((yi > latitude) !== (yj > latitude)) &&
        (longitude < ((xj - xi) * (latitude - yi) / (yj - yi)) + xi);
      if (crosses) inside = !inside;
    }
    return inside;
  }
  function deviceInGroup(device, groupId) {
    if (!groupId) return true;
    return (device.groups || []).some(function (group) { return group.id === groupId; });
  }
  function populateSelect(select, items, placeholder, labelFn) {
    select.innerHTML = "";
    var first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.appendChild(first);
    items.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.id;
      option.textContent = labelFn(item);
      select.appendChild(option);
    });
  }
  function scheduleAppliesNow() {
    var schedule = policySchedule();
    if (schedule.mode === "FullTime") return true;
    if (!schedule.startTime || !schedule.endTime) return false;
    var now = new Date();
    var current = (now.getHours() * 60) + now.getMinutes();
    var start = Number(schedule.startTime.slice(0, 2)) * 60 + Number(schedule.startTime.slice(3));
    var end = Number(schedule.endTime.slice(0, 2)) * 60 + Number(schedule.endTime.slice(3));
    var inWindow = schedule.crossesMidnight ? current >= start || current < end : current >= start && current < end;
    return schedule.mode === "RestrictedWindow" ? inWindow : !inWindow;
  }
  function rowTriggersPolicy(row) {
    if (!row.hasPosition || !scheduleAppliesNow()) return false;
    var trigger = byId("policy-trigger").value;
    if (trigger === "OutsideArea") return row.inside === false;
    if (trigger === "InsideArea") return row.inside === true;
    return trigger === "FullTimeUse";
  }
  function initializeMap() {
    var host = byId("fleet-map");
    if (!host || fleetMap || !window.L) return;
    host.innerHTML = "";
    fleetMap = window.L.map(host, { zoomControl: true }).setView([-40.9, 174.9], 5);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(fleetMap);
    zoneLayer = window.L.featureGroup().addTo(fleetMap);
    vehicleLayer = window.L.featureGroup().addTo(fleetMap);
  }
  function renderMap() {
    initializeMap();
    if (!fleetMap) {
      text("map-status", "The map library could not load. Check that MyGeotab allows access to unpkg.com and openstreetmap.org.");
      return;
    }
    zoneLayer.clearLayers();
    vehicleLayer.clearLayers();
    var zone = zones.find(function (item) { return item.id === byId("zone-select").value; });
    var polygon = zoneCoordinates(zone || {});
    var bounds = [];
    if (polygon.length >= 3) {
      var latLngs = polygon.map(function (point) { return [point.lat, point.lon]; });
      window.L.polygon(latLngs, {
        color: "#1f5fbf", weight: 3, fillColor: "#4f7fd4", fillOpacity: 0.16
      }).bindTooltip(zone.name || "Selected geofence").addTo(zoneLayer);
      bounds = bounds.concat(latLngs);
    }
    var triggeredCount = 0;
    latestRows.forEach(function (row) {
      if (!row.hasPosition) return;
      var triggered = rowTriggersPolicy(row);
      if (triggered) triggeredCount += 1;
      var color = triggered ? "#c62828" : "#15803d";
      window.L.circleMarker([row.latitude, row.longitude], {
        radius: triggered ? 9 : 7,
        color: "#ffffff",
        weight: 2,
        fillColor: color,
        fillOpacity: 1
      }).bindPopup(
        "<strong>" + escapeHtml(row.name) + "</strong><br>" +
        (triggered ? "Policy trigger active" : "Compliant") + "<br>" +
        escapeHtml(row.latitude.toFixed(5) + ", " + row.longitude.toFixed(5))
      ).addTo(vehicleLayer);
      bounds.push([row.latitude, row.longitude]);
    });
    if (bounds.length) fleetMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
    text("map-status", zone
      ? (zone.name || "Selected zone") + ": " + latestRows.filter(function (row) { return row.hasPosition; }).length +
        " positioned vehicle(s), " + triggeredCount + " active trigger(s)."
      : "Select a zone to display its boundary and monitored vehicles.");
    setTimeout(function () { fleetMap.invalidateSize(); }, 0);
  }
  function renderRows() {
    var query = byId("vehicle-search").value.trim().toLowerCase();
    var visible = latestRows.filter(function (row) {
      return !query || row.name.toLowerCase().indexOf(query) !== -1;
    });
    if (!visible.length) {
      byId("results-body").innerHTML = '<tr><td colspan="6" class="empty">No matching live vehicle records.</td></tr>';
      return;
    }
    byId("results-body").innerHTML = visible.map(function (row) {
      var badge = row.inside === true ? "inside" : row.inside === false ? "outside" : "unknown";
      var label = row.inside === true ? "Inside" : row.inside === false ? "Outside" : "No position";
      var when = row.dateTime ? new Date(row.dateTime).toLocaleString() : "—";
      var speed = Number.isFinite(row.speed) ? Math.round(row.speed) + " km/h" : "—";
      var coordinates = row.hasPosition ? row.latitude.toFixed(5) + ", " + row.longitude.toFixed(5) : "—";
      var map = row.hasPosition
        ? '<a class="map-link" target="_blank" rel="noopener" href="https://www.google.com/maps?q=' +
          encodeURIComponent(row.latitude + "," + row.longitude) + '">Map</a>' : "";
      return "<tr><td><strong>" + escapeHtml(row.name) + "</strong></td>" +
        '<td><span class="badge ' + badge + '">' + label + "</span></td>" +
        "<td>" + escapeHtml(when) + "</td><td>" + escapeHtml(speed) + "</td>" +
        "<td>" + escapeHtml(coordinates) + "</td><td>" + map + "</td></tr>";
    }).join("");
  }
  async function refresh() {
    var zoneId = byId("zone-select").value;
    if (!zoneId) {
      showMessage("Select a Geotab zone to begin.", false);
      latestRows = [];
      renderRows();
      renderMap();
      return;
    }
    var zone = zones.find(function (item) { return item.id === zoneId; });
    var polygon = zoneCoordinates(zone || {});
    if (polygon.length < 3) {
      showMessage("The selected zone does not contain a valid polygon boundary.", true);
      return;
    }
    var groupId = byId("group-select").value;
    var selectedDevices = devices.filter(function (device) { return deviceInGroup(device, groupId); });
    var selectedIds = new Set(selectedDevices.map(function (device) { return device.id; }));
    var refreshButton = byId("refresh-button");
    refreshButton.disabled = true;
    showMessage("Loading current positions from MyGeotab…", false);
    try {
      var statuses = await apiCall("Get", { typeName: "DeviceStatusInfo" });
      var statusMap = new Map();
      (statuses || []).forEach(function (status) {
        if (status.device && selectedIds.has(status.device.id)) statusMap.set(status.device.id, status);
      });
      latestRows = selectedDevices.map(function (device) {
        var status = statusMap.get(device.id);
        var latitude = status ? Number(status.latitude) : NaN;
        var longitude = status ? Number(status.longitude) : NaN;
        var hasPosition = Number.isFinite(latitude) && Number.isFinite(longitude) &&
          !(latitude === 0 && longitude === 0);
        return {
          id: device.id,
          name: device.name || device.serialNumber || device.id,
          latitude: latitude,
          longitude: longitude,
          hasPosition: hasPosition,
          inside: hasPosition ? isInsidePolygon(latitude, longitude, polygon) : null,
          speed: status && Number.isFinite(Number(status.speed)) ? Number(status.speed) : null,
          dateTime: status && status.dateTime ? status.dateTime : null
        };
      }).sort(function (a, b) {
        var rankA = a.inside === false ? 0 : a.inside === true ? 1 : 2;
        var rankB = b.inside === false ? 0 : b.inside === true ? 1 : 2;
        return rankA - rankB || a.name.localeCompare(b.name);
      });
      var withPosition = latestRows.filter(function (row) { return row.hasPosition; });
      text("total-count", withPosition.length);
      text("inside-count", withPosition.filter(function (row) { return row.inside; }).length);
      text("outside-count", withPosition.filter(function (row) { return row.inside === false; }).length);
      text("missing-count", latestRows.length - withPosition.length);
      text("last-updated", "Live snapshot updated " + new Date().toLocaleString());
      renderRows();
      renderMap();
      showMessage("Showing " + selectedDevices.length + " accessible vehicle" +
        (selectedDevices.length === 1 ? "" : "s") + " against “" + zone.name + "”.", false);
    } catch (error) {
      showMessage("Could not load current positions: " + errorText(error), true);
    } finally {
      refreshButton.disabled = false;
    }
  }
  function setMonitoring(enabled) {
    monitoring = enabled;
    if (timer) clearInterval(timer);
    timer = null;
    byId("monitor-button").textContent = enabled ? "Stop monitoring" : "Start monitoring";
    if (enabled) {
      var milliseconds = Number(byId("interval-select").value) * 1000;
      timer = setInterval(refresh, milliseconds);
      refresh();
    }
  }
  async function createPolicy() {
    if (!apiRef) {
      showPolicyResult("MyGeotab has not initialized this add-in. Reinstall the embedded add-in package, refresh MyGeotab, then open it from the menu.", "error");
      return;
    }
    var zoneId = byId("zone-select").value;
    var groupId = byId("group-select").value;
    var trigger = byId("policy-trigger").value;
    var name = byId("policy-name").value.trim();
    var zone = zones.find(function (item) { return item.id === zoneId; });
    var group = groups.find(function (item) { return item.id === groupId; });
    var schedule = policySchedule();
    var notifications = notificationSettings();

    if (!zone) {
      showPolicyResult("Select a Geotab zone first.", "error");
      return;
    }
    if (!group) {
      showPolicyResult("Select a specific vehicle group for this policy. This prevents unintentionally applying a new rule to the entire company.", "error");
      return;
    }
    if (!name) {
      name = (trigger === "OutsideArea" ? "Outside " : "Inside ") + (zone.name || "Geofence");
      byId("policy-name").value = name;
    }
    if (schedule.mode !== "FullTime" &&
        (!schedule.startTime || !schedule.endTime || schedule.startTime === schedule.endTime)) {
      showPolicyResult("Choose two different times for the policy window.", "error");
      return;
    }
    if (notifications.enabled && !notifications.webhookUrl) {
      showPolicyResult("Enter the secure notification service URL before creating an email alert.", "error");
      return;
    }

    var action = trigger === "OutsideArea" ? "outside" : "inside";
    var scheduleDescription = schedule.mode === "FullTime"
      ? "at all times"
      : (schedule.mode === "RestrictedWindow" ? "during the restricted window " : "outside the permitted window ") +
        schedule.startTime + "–" + schedule.endTime + (schedule.crossesMidnight ? " (next day)" : "");
    var confirmed = window.confirm(
      "Create the policy “" + name + "”?\n\n" +
      "It will trigger when vehicles in “" + group.name + "” are " + action +
      " the “" + zone.name + "” geofence, " + scheduleDescription + "." +
      (notifications.enabled ? "\n\nEmail alerts will be registered with the secure notification service." : "")
    );
    if (!confirmed) return;

    var button = byId("create-policy-button");
    var createdRuleId = null;
    var workTimeId = null;
    button.disabled = true;
    showPolicyResult("Checking existing Geotab rules…", "");
    try {
      var rules = await apiCall("Get", { typeName: "Rule" });
      var duplicate = (rules || []).find(function (rule) {
        return (rule.name || "").trim().toLowerCase() === name.toLowerCase();
      });
      if (duplicate) {
        showPolicyResult("A Geotab rule named “" + name + "” already exists. Nothing was created.", "error");
        return;
      }

      workTimeId = await createPolicyWorkTime(name, schedule);
      var entity = {
        name: name,
        comment: "Created by Live Geofence Monitor; attached zone: " + (zone.name || zone.id) +
          "; schedule: " + scheduleDescription,
        baseType: "Custom",
        color: { r: 180, g: 35, b: 24, a: 255 },
        groups: [{ id: group.id }],
        condition: buildRuleCondition(trigger, zone.id, schedule, workTimeId)
      };
      var ruleId = await apiCall("Add", { typeName: "Rule", entity: entity });
      createdRuleId = ruleId;
      var distributionListId = await createNativeEmailDistribution(
        name,
        ruleId,
        notifications.backOfficeEmails
      );
      var needsExternalDelivery = notifications.enabled &&
        (notifications.notifyAssignedDriver || notifications.attachMapImage);
      if (needsExternalDelivery) {
        if (!notifications.webhookUrl) throw new Error(
          "The Geotab rule was created, but driver-specific email and map attachments require the secure notification service URL."
        );
        await registerPolicyDelivery({
          eventType: "geofencePolicyCreated",
          ruleId: ruleId,
          policyName: name,
          geotab: {
            zoneId: zone.id,
            zoneName: zone.name,
            groupId: group.id,
            groupName: group.name,
            trigger: trigger
          },
          schedule: schedule,
          notifications: {
            enabled: notifications.enabled,
            notifyAssignedDriver: notifications.notifyAssignedDriver,
            backOfficeEmails: notifications.backOfficeEmails,
            includeLocationLink: notifications.includeLocationLink,
            attachMapImage: notifications.attachMapImage,
            cooldownMinutes: notifications.cooldownMinutes
          }
        }, notifications.webhookUrl);
      }
      showPolicyResult(
        "Policy created successfully. Rule ID: " + ruleId + ". Geofence “" +
        zone.name + "” is attached to group “" + group.name + "”." +
        (workTimeId ? " WorkTime ID: " + workTimeId + "." : "") +
        (distributionListId ? " Email distribution ID: " + distributionListId + "." : "") +
        (needsExternalDelivery ? " Driver delivery and map attachments are registered." : ""),
        "success"
      );
    } catch (error) {
      showPolicyResult(createdRuleId
        ? "Geotab rule " + createdRuleId + " was created, but notification registration failed: " + errorText(error)
        : "Policy could not be created: " + errorText(error) +
          ". Confirm your MyGeotab user has permission to manage rules.", "error");
    } finally {
      button.disabled = false;
    }
  }
  async function loadReferenceData() {
    showMessage("Loading zones, vehicles, and groups from MyGeotab…", false);
    try {
      var result = await apiMultiCall([
        ["Get", { typeName: "Zone" }],
        ["Get", { typeName: "Device" }],
        ["Get", { typeName: "Group" }]
      ]);
      zones = (result[0] || []).filter(function (zone) { return zoneCoordinates(zone).length >= 3; })
        .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
      devices = (result[1] || []).filter(function (device) { return device.id && device.name; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      groups = (result[2] || []).filter(function (group) { return group.id && group.name; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      populateSelect(byId("zone-select"), zones,
        zones.length ? "Select a Geotab zone" : "No accessible polygon zones", function (zone) { return zone.name || zone.id; });
      populateSelect(byId("group-select"), groups, "All accessible vehicles", function (group) { return group.name; });
      text("connection-text", "Connected to MyGeotab");
      byId("connection-dot").className = "dot online";
      showMessage(zones.length
        ? "Choose a zone, then refresh or start monitoring."
        : "No polygon zones are available to this user. Create a Zone in MyGeotab or check access permissions.", !zones.length);
      renderRows();
      renderMap();
    } catch (error) {
      text("connection-text", "Connection error");
      byId("connection-dot").className = "dot error";
      showMessage("Could not load Geotab data: " + errorText(error), true);
    }
  }
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    byId("refresh-button").addEventListener("click", refresh);
    byId("monitor-button").addEventListener("click", function () { setMonitoring(!monitoring); });
    byId("create-policy-button").addEventListener("click", createPolicy);
    byId("vehicle-search").addEventListener("input", renderRows);
    byId("zone-select").addEventListener("change", refresh);
    byId("zone-select").addEventListener("change", function () {
      var zone = zones.find(function (item) { return item.id === byId("zone-select").value; });
      if (zone && !byId("policy-name").value.trim()) {
        byId("policy-name").value = "Outside " + zone.name;
      }
      showPolicyResult("", "");
    });
    byId("group-select").addEventListener("change", refresh);
    byId("interval-select").addEventListener("change", function () {
      if (monitoring) setMonitoring(true);
    });
    Array.prototype.forEach.call(document.querySelectorAll(
      'input[name="policy-rule-logic"], input[name="policy-schedule-mode"], #policy-start-time, #policy-end-time'
    ), function (control) {
      control.addEventListener("change", renderMap);
    });
  }

  window.addEventListener("DOMContentLoaded", function () {
    bindEvents();
    initializeMap();
  });

  if (window.geotab && window.geotab.addin) {
    window.geotab.addin.geofenceMonitor = function () {
      return {
        initialize: function (api, state, callback) {
          apiRef = api;
          bindEvents();
          initializeMap();
          callback();
        },
        focus: function (api) {
          apiRef = api;
          loadReferenceData();
        },
        blur: function () {
          setMonitoring(false);
        }
      };
    };
  } else {
    window.addEventListener("DOMContentLoaded", function () {
      text("connection-text", "MyGeotab connection required");
      byId("connection-dot").className = "dot error";
      showMessage("This local file is a visual preview. Install and open the add-in inside MyGeotab to load zones, vehicles, triggers, and create policies.", true);
    });
  }
}());
