(function () {
  "use strict";

  var apiRef = null;
  var sessionTimeZoneId = null;
  var sessionTimeZoneFormatter = null;
  var sessionTimeZoneLookupFailed = false;
  var sessionTimeZonePromise = null;
  var timer = null;
  var monitoring = false;
  var devices = [];
  var groups = [];
  var zones = [];
  var rules = [];
  var workTimes = [];
  var distributionLists = [];
  var latestRows = [];
  var eventsBound = false;
  var referenceDataLoadedAt = 0;
  var referenceDataPromise = null;
  var zoneSearchMode = false;
  var zoneSearchTimer = null;
  var referenceCacheMilliseconds = 5 * 60 * 1000;

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
  function getApiSession() {
    return new Promise(function (resolve, reject) {
      apiRef.getSession(resolve, reject);
    });
  }
  async function loadSessionTimeZone() {
    if (sessionTimeZonePromise) return sessionTimeZonePromise;
    sessionTimeZonePromise = (async function () {
      try {
        var session = await getApiSession();
        if (!session || !session.userName) throw new Error("The MyGeotab session did not include a user name.");
        var users = await apiCall("Get", {
          typeName: "User",
          search: { name: session.userName }
        });
        if (!users || !users.length || !users[0].timeZoneId) {
          throw new Error("The signed-in MyGeotab user does not have a timezone.");
        }
        sessionTimeZoneFormatter = new Intl.DateTimeFormat("en-NZ", {
          timeZone: users[0].timeZoneId,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        });
        sessionTimeZoneFormatter.formatToParts(new Date());
        sessionTimeZoneId = users[0].timeZoneId;
        sessionTimeZoneLookupFailed = false;
      } catch (error) {
        sessionTimeZoneId = null;
        sessionTimeZoneFormatter = null;
        sessionTimeZoneLookupFailed = true;
      }
      renderMap();
    })();
    return sessionTimeZonePromise;
  }
  function mapTimeZoneWarning() {
    return sessionTimeZoneLookupFailed ? " Timezone unavailable; policy preview is using this browser’s local time." : "";
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
  function activeFromDate() {
    return new Date().toISOString();
  }
  async function loadDevicesForGroup(groupId) {
    var search = { fromDate: activeFromDate() };
    if (groupId) search.groups = [{ id: groupId }];
    var result = await apiCall("Get", { typeName: "Device", search: search });
    devices = (result || []).filter(function (device) { return device.id && device.name; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function setSelectedZone(zone) {
    zones = zone ? [zone] : [];
    populateSelect(byId("zone-select"), zones, "Select a Geotab zone", function (item) {
      return item.name || item.id;
    });
    byId("zone-select").value = zone ? zone.id : "";
    byId("zone-select").dispatchEvent(new Event("change"));
  }
  async function searchZonesByName() {
    var input = byId("zone-search-input");
    var results = byId("zone-search-results");
    var status = byId("zone-search-status");
    var query = input.value.trim();
    if (query.length < 2) {
      results.hidden = true;
      status.hidden = false;
      status.textContent = "Enter at least 2 characters.";
      return;
    }
    status.hidden = false;
    status.textContent = "Searching MyGeotab geofences…";
    try {
      var matches = await apiCall("Get", {
        typeName: "Zone",
        search: { name: "%" + query + "%", fromDate: activeFromDate() }
      });
      var polygonZones = (matches || []).filter(function (zone) {
        return zoneCoordinates(zone).length >= 3;
      }).slice(0, 100).sort(function (a, b) {
        return (a.name || "").localeCompare(b.name || "");
      });
      results.innerHTML = "";
      polygonZones.forEach(function (zone) {
        var option = document.createElement("option");
        option.value = zone.id;
        option.textContent = zone.name || zone.id;
        results.appendChild(option);
      });
      zones = polygonZones;
      results.hidden = !polygonZones.length;
      status.textContent = polygonZones.length
        ? polygonZones.length + " matching geofence(s). Select one below."
        : "No matching polygon geofences.";
    } catch (error) {
      results.hidden = true;
      status.textContent = "Geofence search failed: " + errorText(error);
    }
  }
  function findCondition(condition, type) {
    if (!condition) return null;
    if (condition.conditionType === type) return condition;
    var children = condition.children || [];
    for (var i = 0; i < children.length; i += 1) {
      var found = findCondition(children[i], type);
      if (found) return found;
    }
    return null;
  }
  function policyLogicLabel(condition) {
    if (findCondition(condition, "OutsideArea")) return "Outside area";
    if (findCondition(condition, "InsideArea") && findCondition(condition, "Ignition")) return "Vehicle use inside zone";
    if (findCondition(condition, "InsideArea")) return "Inside area";
    return "Custom rule";
  }
  function policyScheduleLabel(condition) {
    var during = findCondition(condition, "RuleWorkHours");
    var after = findCondition(condition, "AfterRuleWorkHours");
    var workCondition = during || after;
    if (!workCondition || !workCondition.workTime) return "Full time";
    var workTime = workTimes.find(function (item) { return item.id === workCondition.workTime.id; });
    return (during ? "Restricted: " : "Outside permitted hours: ") +
      (workTime ? workTime.name : workCondition.workTime.id);
  }
  function renderCreatedPolicies() {
    var body = byId("created-policies-body");
    var managed = rules.filter(function (rule) {
      return (rule.comment || "").indexOf("Created by Live Geofence Monitor") !== -1;
    }).sort(function (a, b) {
      return (a.name || "").localeCompare(b.name || "");
    });
    if (!managed.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No policies created by this add-in were found.</td></tr>';
      text("created-policies-status", "0 created policies");
      return;
    }
    body.innerHTML = managed.map(function (rule) {
      var zoneCondition = findCondition(rule.condition, "OutsideArea") || findCondition(rule.condition, "InsideArea");
      var zone = zoneCondition && zoneCondition.zone
        ? zones.find(function (item) { return item.id === zoneCondition.zone.id; })
        : null;
      var groupNames = (rule.groups || []).map(function (reference) {
        var group = groups.find(function (item) { return item.id === reference.id; });
        return group ? group.name : (reference.id === "GroupCompanyId" ? "All accessible vehicles" : reference.id);
      });
      var lists = distributionLists.filter(function (list) {
        return (list.rules || []).some(function (reference) { return reference.id === rule.id; });
      });
      var recipientCount = lists.reduce(function (total, list) {
        return total + (list.recipients || []).length;
      }, 0);
      return "<tr>" +
        "<td><strong>" + escapeHtml(rule.name || "Unnamed policy") + "</strong></td>" +
        "<td>" + escapeHtml(zone ? zone.name : "—") + "</td>" +
        "<td>" + escapeHtml(groupNames.join(", ") || "—") + "</td>" +
        "<td>" + escapeHtml(policyLogicLabel(rule.condition)) + "</td>" +
        "<td>" + escapeHtml(policyScheduleLabel(rule.condition)) + "</td>" +
        "<td>" + escapeHtml(recipientCount ? recipientCount + " recipient(s)" : "None") + "</td>" +
        "<td><code>" + escapeHtml(rule.id) + "</code></td>" +
        "</tr>";
    }).join("");
    text("created-policies-status", managed.length + " created polic" + (managed.length === 1 ? "y" : "ies"));
  }
  async function loadPolicyData() {
    var button = byId("refresh-policies-button");
    if (!apiRef) {
      text("created-policies-status", "MyGeotab connection required");
      return;
    }
    button.disabled = true;
    text("created-policies-status", "Refreshing MyGeotab rules…");
    try {
      rules = await apiCall("Get", {
        typeName: "Rule",
        search: { baseType: "Custom" }
      }) || [];
      workTimes = [];
      distributionLists = [];
      renderCreatedPolicies();
      var workTimeIds = [];
      rules.forEach(function (rule) {
        var during = findCondition(rule.condition, "RuleWorkHours");
        var after = findCondition(rule.condition, "AfterRuleWorkHours");
        var condition = during || after;
        if (condition && condition.workTime && workTimeIds.indexOf(condition.workTime.id) === -1) {
          workTimeIds.push(condition.workTime.id);
        }
      });
      try {
        var workTimeResults = await Promise.all(workTimeIds.map(function (id) {
          return apiCall("Get", { typeName: "WorkTime", search: { id: id } });
        }));
        workTimes = [].concat.apply([], workTimeResults);
        distributionLists = await apiCall("Get", {
          typeName: "DistributionList",
          search: { name: "% email alerts" }
        }) || [];
        renderCreatedPolicies();
      } catch (detailError) {
        renderCreatedPolicies();
        text("created-policies-status",
          rules.filter(function (rule) {
            return (rule.comment || "").indexOf("Created by Live Geofence Monitor") !== -1;
          }).length + " created policies; notification or schedule details could not be loaded");
      }
    } catch (error) {
      text("created-policies-status", "Could not load policies: " + errorText(error));
    } finally {
      button.disabled = false;
    }
  }
  function scheduleAppliesNow() {
    var schedule = policySchedule();
    if (schedule.mode === "FullTime") return true;
    if (!schedule.startTime || !schedule.endTime) return false;
    var now = new Date();
    var current;
    if (sessionTimeZoneId && sessionTimeZoneFormatter) {
      var parts = sessionTimeZoneFormatter.formatToParts(now);
      var hour = Number(parts.find(function (part) { return part.type === "hour"; }).value);
      var minute = Number(parts.find(function (part) { return part.type === "minute"; }).value);
      current = (hour * 60) + minute;
    } else {
      current = (now.getHours() * 60) + now.getMinutes();
    }
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
    if (trigger === "FullTimeUse") return row.inside === true;
    return false;
  }
  function renderMap() {
    var zone = zones.find(function (item) { return item.id === byId("zone-select").value; });
    var triggeredCount = 0;
    latestRows.forEach(function (row) {
      if (!row.hasPosition) return;
      var triggered = rowTriggersPolicy(row);
      if (triggered) triggeredCount += 1;
    });
    text("map-status", zone
      ? (zone.name || "Selected zone") + ": " + latestRows.filter(function (row) { return row.hasPosition; }).length +
        " positioned vehicle(s), " + triggeredCount +
        " spatial trigger(s). Open the native MyGeotab map to view them." + mapTimeZoneWarning()
      : "Select a zone, then open the native MyGeotab map." + mapTimeZoneWarning());
  }
  function openNativeMap() {
    var ids = latestRows.filter(function (row) {
      return row.hasPosition && row.id;
    }).map(function (row) {
      return row.id;
    });
    window.parent.location.hash = ids.length
      ? "map,liveVehicleIds:!(" + ids.join(",") + ")"
      : "map";
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
    showMessage(groupId
      ? "Loading current positions for the selected group from MyGeotab…"
      : "No vehicle group is selected. This position query covers the whole database.", false);
    try {
      var statusParams = { typeName: "DeviceStatusInfo" };
      if (groupId) {
        statusParams.search = { deviceSearch: { groups: [{ id: groupId }] } };
      }
      var statuses = await apiCall("Get", statusParams);
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
        (selectedDevices.length === 1 ? "" : "s") + " against “" + zone.name + "”." +
        (groupId ? "" : " Warning: no group is selected, so the position query covers the whole database."), false);
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
      var milliseconds = Math.max(30, Number(byId("interval-select").value)) * 1000;
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
    var group = groupId
      ? groups.find(function (item) { return item.id === groupId; })
      : { id: "GroupCompanyId", name: "All accessible vehicles" };
    var schedule = policySchedule();
    var notifications = notificationSettings();

    if (!zone) {
      showPolicyResult("Select a Geotab zone first.", "error");
      return;
    }
    if (!group) {
      showPolicyResult("The selected vehicle group is no longer available. Reload the group list and select it again.", "error");
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
    if ((notifications.notifyAssignedDriver || notifications.attachMapImage) && !notifications.webhookUrl) {
      showPolicyResult("Enter the secure notification service URL for driver-specific delivery or map-image attachments.", "error");
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
      var matchingRules = await apiCall("Get", {
        typeName: "Rule",
        search: { name: name }
      });
      var duplicate = (matchingRules || []).find(function (rule) {
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
      entity.id = ruleId;
      rules.push(entity);
      renderCreatedPolicies();
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
      await loadPolicyData();
    } catch (error) {
      showPolicyResult(createdRuleId
        ? "Geotab rule " + createdRuleId + " was created, but notification registration failed: " + errorText(error)
        : "Policy could not be created: " + errorText(error) +
          ". Confirm your MyGeotab user has permission to manage rules.", "error");
    } finally {
      updatePolicyFormState();
    }
  }
  function loadReferenceData(force) {
    if (!force && referenceDataLoadedAt &&
        Date.now() - referenceDataLoadedAt < referenceCacheMilliseconds) {
      return Promise.resolve();
    }
    if (referenceDataPromise) return referenceDataPromise;
    referenceDataPromise = (async function () {
      showMessage("Loading zones, vehicles, and groups from MyGeotab…", false);
      try {
        var zoneCount = await apiCall("GetCountOf", { typeName: "Zone" });
        zoneSearchMode = Number(zoneCount) > 500;
        var calls = [
          ["Get", { typeName: "Device", search: { fromDate: activeFromDate() } }],
          ["Get", { typeName: "Group", search: { name: "%" } }]
        ];
        if (!zoneSearchMode) {
          calls.push(["Get", { typeName: "Zone", search: { fromDate: activeFromDate() } }]);
        }
        var result = await apiMultiCall(calls);
        devices = (result[0] || []).filter(function (device) { return device.id && device.name; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
        groups = (result[1] || []).filter(function (group) { return group.id && group.name; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
        zones = zoneSearchMode ? [] : (result[2] || []).filter(function (zone) {
          return zoneCoordinates(zone).length >= 3;
        }).sort(function (a, b) {
          return (a.name || "").localeCompare(b.name || "");
        });
        byId("zone-select").hidden = zoneSearchMode;
        byId("zone-search-input").hidden = !zoneSearchMode;
        byId("zone-search-status").hidden = !zoneSearchMode;
        byId("zone-search-results").hidden = true;
        if (zoneSearchMode) {
          populateSelect(byId("zone-select"), [], "Search for a Geotab zone", function (zone) {
            return zone.name || zone.id;
          });
          text("zone-search-status", "This database has " + zoneCount +
            " geofences. Search by name instead of loading the full list.");
        } else {
          populateSelect(byId("zone-select"), zones,
            zones.length ? "Select a Geotab zone" : "No accessible polygon zones",
            function (zone) { return zone.name || zone.id; });
        }
        populateSelect(byId("group-select"), groups, "All accessible vehicles", function (group) {
          return group.name;
        });
        referenceDataLoadedAt = Date.now();
        text("connection-text", "Connected to MyGeotab");
        byId("connection-dot").className = "dot online";
        showMessage(zoneSearchMode
          ? "Search for a geofence by name, then select a vehicle group."
          : (zones.length
            ? "Choose a zone, then refresh or start monitoring."
            : "No polygon zones are available to this user. Create a Zone in MyGeotab or check access permissions."),
        !zoneSearchMode && !zones.length);
        renderRows();
        renderMap();
        await loadPolicyData();
      } catch (error) {
        text("connection-text", "Connection error");
        byId("connection-dot").className = "dot error";
        showMessage("Could not load Geotab data: " + errorText(error), true);
      } finally {
        referenceDataPromise = null;
      }
    })();
    return referenceDataPromise;
  }
  function validPolicyEmailList(value) {
    var addresses = value.split(",").map(function (item) { return item.trim(); }).filter(Boolean);
    return addresses.length > 0 && addresses.every(function (address) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
    });
  }
  function formatPolicyTime(value) {
    if (!value) return "";
    var parts = value.split(":");
    var hour = Number(parts[0]);
    var minute = parts[1];
    var suffix = hour >= 12 ? "PM" : "AM";
    var displayHour = hour % 12 || 12;
    return displayHour + ":" + minute + " " + suffix;
  }
  function updatePolicyFormState() {
    var zone = byId("zone-select");
    var group = byId("group-select");
    var name = byId("policy-name");
    var trigger = byId("policy-trigger");
    var schedule = byId("policy-schedule");
    var crossesMidnight = byId("policy-time-crosses-midnight");
    var timeWindow = byId("policy-time-window");
    var startTime = byId("policy-start-time");
    var endTime = byId("policy-end-time");
    var notifyDriver = byId("notify-driver");
    var notifyBackOffice = byId("notify-back-office");
    var backOfficeEmails = byId("back-office-emails");
    var attachMapImage = byId("attach-map-image");
    var notificationWebhookUrl = byId("notification-webhook-url");
    var selectedRule = document.querySelector('input[name="policy-rule-logic"]:checked');
    var selectedSchedule = document.querySelector('input[name="policy-schedule-mode"]:checked');
    var create = byId("create-policy-button");

    trigger.value = selectedRule ? selectedRule.value : "";
    schedule.value = selectedSchedule ? selectedSchedule.value : "";
    var usesWindow = schedule.value === "PermittedWindow" || schedule.value === "RestrictedWindow";
    var isRestricted = schedule.value === "RestrictedWindow";
    timeWindow.hidden = !usesWindow;
    text("policy-start-time-label", isRestricted ? "Restricted from" : "Permitted from");
    text("policy-end-time-label", isRestricted ? "Restricted until" : "Permitted until");

    var wraps = usesWindow && startTime.value && endTime.value && endTime.value <= startTime.value;
    crossesMidnight.value = wraps ? "true" : "false";
    if (usesWindow && startTime.value && endTime.value) {
      var action = isRestricted ? "Vehicle use is prohibited in the selected zone" : "Vehicle use is permitted";
      text("policy-time-summary", action + " from " + formatPolicyTime(startTime.value) +
        " until " + formatPolicyTime(endTime.value) + (wraps ? " the following day" : "") + ".");
    }

    var notifications = notificationSettings();
    byId("policy-notifications-enabled").value = String(notifications.enabled);
    byId("notification-details").hidden = !notifications.enabled;
    byId("back-office-email-field").hidden = !notifyBackOffice.checked;
    var recipientsValid = !notifyBackOffice.checked || validPolicyEmailList(backOfficeEmails.value);
    var needsExternalDelivery = notifications.enabled &&
      (notifications.notifyAssignedDriver || notifications.attachMapImage);
    var deliveryValid = !needsExternalDelivery || Boolean(notificationWebhookUrl.value.trim());
    var recipientParts = [];
    if (notifyDriver.checked) recipientParts.push("assigned driver");
    if (notifyBackOffice.checked) {
      recipientParts.push(notifications.backOfficeEmails.length + " back-office recipient" +
        (notifications.backOfficeEmails.length === 1 ? "" : "s"));
    }
    text("notification-summary", notifications.enabled
      ? "Alert will be sent to " + (recipientParts.join(" and ") || "the selected recipients") +
        (attachMapImage.checked ? " with a map image attached" : "") +
        (byId("include-location-link").checked ? " and a location link" : "") + "."
      : "Select at least one recipient.");

    var validTime = !usesWindow || Boolean(startTime.value && endTime.value && startTime.value !== endTime.value);
    var ready = Boolean(zone.value && name.value.trim() && trigger.value &&
      schedule.value && validTime && recipientsValid && deliveryValid);
    create.disabled = !ready;
    create.title = ready ? "Create this policy in MyGeotab"
      : !zone.value ? "Select a geofence first"
      : !name.value.trim() ? "Enter a policy name"
      : !validTime ? "Choose two different policy times"
      : !recipientsValid ? "Enter valid back-office email addresses"
      : !deliveryValid ? "Enter the secure notification service URL"
      : "Complete the policy details";
    text("policy-validation-message", ready ? "Policy details are complete."
      : create.title + ".");
  }
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    byId("refresh-button").addEventListener("click", refresh);
    byId("refresh-reference-button").addEventListener("click", function () {
      loadReferenceData(true);
    });
    byId("monitor-button").addEventListener("click", function () { setMonitoring(!monitoring); });
    byId("create-policy-button").addEventListener("click", createPolicy);
    byId("refresh-policies-button").addEventListener("click", loadPolicyData);
    byId("vehicle-search").addEventListener("input", renderRows);
    byId("zone-select").addEventListener("change", refresh);
    byId("zone-select").addEventListener("change", function () {
      var zone = zones.find(function (item) { return item.id === byId("zone-select").value; });
      if (zone && !byId("policy-name").value.trim()) {
        byId("policy-name").value = "Outside " + zone.name;
      }
      showPolicyResult("", "");
    });
    byId("group-select").addEventListener("change", async function () {
      try {
        await loadDevicesForGroup(byId("group-select").value);
        await refresh();
      } catch (error) {
        showMessage("Could not load vehicles for the selected group: " + errorText(error), true);
      }
    });
    byId("zone-search-input").addEventListener("input", function () {
      if (zoneSearchTimer) clearTimeout(zoneSearchTimer);
      zoneSearchTimer = setTimeout(searchZonesByName, 350);
    });
    byId("zone-search-results").addEventListener("change", function () {
      var zone = zones.find(function (item) {
        return item.id === byId("zone-search-results").value;
      });
      if (zone) {
        byId("zone-search-input").value = zone.name || zone.id;
        byId("zone-search-results").hidden = true;
        setSelectedZone(zone);
      }
    });
    byId("interval-select").addEventListener("change", function () {
      if (monitoring) setMonitoring(true);
    });
    Array.prototype.forEach.call(document.querySelectorAll(
      'input[name="policy-rule-logic"], input[name="policy-schedule-mode"], #policy-start-time, #policy-end-time'
    ), function (control) {
      control.addEventListener("change", renderMap);
    });
    byId("zone-select").addEventListener("change", updatePolicyFormState);
    byId("group-select").addEventListener("change", updatePolicyFormState);
    byId("policy-name").addEventListener("input", updatePolicyFormState);
    Array.prototype.forEach.call(document.querySelectorAll(
      'input[name="policy-rule-logic"], input[name="policy-schedule-mode"]'
    ), function (control) {
      control.addEventListener("change", updatePolicyFormState);
    });
    byId("policy-start-time").addEventListener("change", updatePolicyFormState);
    byId("policy-end-time").addEventListener("change", updatePolicyFormState);
    byId("notify-driver").addEventListener("change", updatePolicyFormState);
    byId("notify-back-office").addEventListener("change", updatePolicyFormState);
    byId("back-office-emails").addEventListener("input", updatePolicyFormState);
    byId("include-location-link").addEventListener("change", updatePolicyFormState);
    byId("attach-map-image").addEventListener("change", updatePolicyFormState);
    byId("notification-cooldown").addEventListener("change", updatePolicyFormState);
    byId("notification-webhook-url").addEventListener("input", updatePolicyFormState);
    byId("open-native-map").addEventListener("click", openNativeMap);
    updatePolicyFormState();
  }

  window.addEventListener("DOMContentLoaded", function () {
    bindEvents();
  });

  if (window.geotab && window.geotab.addin) {
    window.geotab.addin.geofenceMonitor = function () {
      return {
        initialize: function (api, state, callback) {
          apiRef = api;
          bindEvents();
          loadSessionTimeZone();
          callback();
        },
        focus: function (api) {
          apiRef = api;
          loadReferenceData(false);
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
