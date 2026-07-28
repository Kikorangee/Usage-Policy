(function () {
  "use strict";

  var apiRef = null;
  var timer = null;
  var monitoring = false;
  var devices = [];
  var groups = [];
  var zones = [];
  var latestRows = [];

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

      var entity = {
        name: name,
        comment: "Created by Live Geofence Monitor; attached zone: " + (zone.name || zone.id) +
          "; schedule: " + scheduleDescription,
        baseType: "Custom",
        color: { r: 180, g: 35, b: 24, a: 255 },
        groups: [{ id: group.id }],
        condition: {
          conditionType: trigger,
          zone: { id: zone.id }
        }
      };
      var ruleId = await apiCall("Add", { typeName: "Rule", entity: entity });
      createdRuleId = ruleId;
      if (schedule.mode !== "FullTime" || notifications.enabled) {
        if (!notifications.webhookUrl) {
          throw new Error("The Geotab rule was created, but a secure service URL is required to enforce the custom time window.");
        }
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
        (notifications.enabled ? " Email delivery and map attachments are registered." : ""),
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
    } catch (error) {
      text("connection-text", "Connection error");
      byId("connection-dot").className = "dot error";
      showMessage("Could not load Geotab data: " + errorText(error), true);
    }
  }
  function bindEvents() {
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
  }

  geotab.addin.geofenceMonitor = function () {
    return {
      initialize: function (api, state, callback) {
        apiRef = api;
        bindEvents();
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
}());
