(function () {
  "use strict";

  var apiRef = null;
  var timer = null;
  var monitoring = false;
  var devices = [];
  var groups = [];
  var zones = [];
  var workTimes = [];
  var latestRows = [];
  var liveMap = null;
  var zoneLayer = null;
  var vehicleLayer = null;
  var lastMappedZoneId = "";
  var POLICY_TEMPLATES = {
    fullUse: { name: "Full Use", group: "Full Use", zone: null, trigger: null, vehicles: ["520", "529", "541", "543", "544", "546"] },
    northland: { name: "Northland Region Only", group: "Northland Region", zone: "Northland Region", trigger: "OutsideArea", vehicles: ["490", "517", "518", "519", "530", "534", "535", "542", "552", "553"] },
    whangarei: { name: "Whangarei District + 30km", group: "Whangarei District", zone: "Whangarei District", trigger: "OutsideArea", vehicles: ["471", "502", "508", "510", "513", "515", "516", "522", "526", "527", "533", "537", "538", "539", "540", "545", "549", "550"] },
    hawkesBay: { name: "Hawkes Bay Region", group: "Hawkes Bay", zone: "Hawkes Bay Region", trigger: "OutsideArea", vehicles: ["536"] },
    napier: { name: "Napier District + 30km", group: "Napier District", zone: "Napier District", trigger: "OutsideArea", vehicles: ["521", "523", "551"] },
    timeRestricted: { name: "Time-Restricted Trade Staff", group: "Time-Restricted Trade Staff", zone: null, trigger: "AfterRuleWorkHours", vehicles: ["465", "470", "476", "487", "488", "489", "491", "492", "493", "494", "495", "496", "500", "501", "503", "505", "511", "512", "514", "524", "525", "528", "531", "532"] }
  };

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
  function zoneCoordinates(zone) {
    return (zone.points || []).map(function (point) {
      var lon = Number(point.x);
      var lat = Number(point.y);
      return { lat: lat, lon: lon };
    }).filter(function (point) {
      return Number.isFinite(point.lat) && Number.isFinite(point.lon);
    });
  }
  function initializeMap() {
    if (liveMap || typeof window.L === "undefined") {
      if (typeof window.L === "undefined") {
        byId("live-map").hidden = true;
        byId("map-fallback").hidden = false;
      }
      return;
    }
    liveMap = window.L.map("live-map", { preferCanvas: true }).setView([-35.725, 174.323], 8);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(liveMap);
    zoneLayer = window.L.layerGroup().addTo(liveMap);
    vehicleLayer = window.L.layerGroup().addTo(liveMap);
  }
  function fitMap() {
    if (!liveMap) return;
    var layers = [];
    if (zoneLayer) zoneLayer.eachLayer(function (layer) { layers.push(layer); });
    if (vehicleLayer) vehicleLayer.eachLayer(function (layer) { layers.push(layer); });
    if (layers.length) {
      var group = window.L.featureGroup(layers);
      if (group.getBounds().isValid()) liveMap.fitBounds(group.getBounds().pad(0.12), { maxZoom: 15 });
    }
  }
  function renderMap(forceFit) {
    initializeMap();
    if (!liveMap) return;
    zoneLayer.clearLayers();
    vehicleLayer.clearLayers();
    var zoneId = byId("zone-select").value;
    var zone = zones.find(function (item) { return item.id === zoneId; });
    var polygon = zone ? zoneCoordinates(zone) : [];
    if (polygon.length >= 3) {
      window.L.polygon(polygon.map(function (point) { return [point.lat, point.lon]; }), {
        color: "#3157d5", weight: 3, fillColor: "#3157d5", fillOpacity: 0.12
      }).bindPopup("<strong>" + escapeHtml(zone.name || "Selected geofence") + "</strong>").addTo(zoneLayer);
    }
    latestRows.filter(function (row) { return row.hasPosition; }).forEach(function (row) {
      var color = row.inside === true ? "#19764a" : row.inside === false ? "#b42318" : "#657087";
      var status = row.inside === true ? "Inside geofence" : row.inside === false ? "Outside geofence" : "Position only";
      var marker = window.L.circleMarker([row.latitude, row.longitude], {
        radius: 7, color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 1
      });
      marker.bindPopup(
        '<div class="vehicle-popup"><strong>' + escapeHtml(row.name) + "</strong>" +
        escapeHtml(status) + "<br>" +
        escapeHtml(row.latitude.toFixed(5) + ", " + row.longitude.toFixed(5)) + "<br>" +
        escapeHtml(row.dateTime ? new Date(row.dateTime).toLocaleString() : "No position time") + "</div>"
      );
      marker.addTo(vehicleLayer);
    });
    if (forceFit || zoneId !== lastMappedZoneId) fitMap();
    lastMappedZoneId = zoneId;
    setTimeout(function () { liveMap.invalidateSize(); }, 0);
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
  function vehicleNumber(device) {
    var match = String(device.name || "").match(/(?:^|\D)(\d{3})(?:\D|$)/);
    return match ? match[1] : "";
  }
  function findByName(items, expected) {
    var needle = String(expected || "").toLowerCase();
    return items.find(function (item) {
      return String(item.name || "").toLowerCase() === needle;
    }) || items.find(function (item) {
      return String(item.name || "").toLowerCase().indexOf(needle) !== -1;
    });
  }
  function selectedTemplate() {
    return POLICY_TEMPLATES[byId("policy-template").value] || null;
  }
  function updatePolicyPreview() {
    var template = selectedTemplate();
    if (!template) {
      byId("policy-preview").textContent = "Custom policy: select an existing Geotab group and zone, then choose inside or outside.";
      byId("create-policy-button").disabled = false;
      return;
    }
    var group = findByName(groups, template.group);
    var zone = template.zone ? findByName(zones, template.zone) : null;
    var expected = new Set(template.vehicles);
    var matched = devices.filter(function (device) { return expected.has(vehicleNumber(device)); });
    var found = new Set(matched.map(vehicleNumber));
    var missing = template.vehicles.filter(function (number) { return !found.has(number); });
    var unassigned = group ? matched.filter(function (device) { return !deviceInGroup(device, group.id); }).map(vehicleNumber) : [];
    var parts = [
      "Guide roster: " + template.vehicles.length + " vehicles; " + matched.length + " matched by live device name.",
      "Group: " + (group ? "found (“" + group.name + "”)" : "not found (“" + template.group + "”)") + "."
    ];
    if (template.zone) parts.push("Geofence: " + (zone ? "found (“" + zone.name + "”)" : "not found (“" + template.zone + "”)") + ".");
    if (missing.length) parts.push("Unmatched vehicle numbers: " + missing.join(", ") + ".");
    if (unassigned.length) parts.push("Matched but not assigned to this group: " + unassigned.join(", ") + ".");
    if (template.trigger === "AfterRuleWorkHours") {
      parts.push("Rule: flag usage during 04:00–18:00 Monday–Friday; weekends are permitted.");
    } else if (!template.trigger) {
      parts.push("Full Use is unrestricted, so no exception rule will be created.");
    } else {
      parts.push("Rule: flag vehicles outside the attached geofence.");
    }
    byId("policy-preview").textContent = parts.join(" ");
    byId("group-select").value = group ? group.id : "";
    if (template.zone) byId("zone-select").value = zone ? zone.id : "";
    byId("policy-name").value = template.name;
    if (template.trigger === "InsideArea" || template.trigger === "OutsideArea") byId("policy-trigger").value = template.trigger;
    byId("create-policy-button").disabled = !template.trigger;
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
      renderMap(false);
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
    var template = selectedTemplate();
    var zone = zones.find(function (item) { return item.id === byId("zone-select").value; });
    var group = groups.find(function (item) { return item.id === byId("group-select").value; });
    var trigger = byId("policy-trigger").value;
    var name = byId("policy-name").value.trim();
    var isTimePolicy = template && template.trigger === "AfterRuleWorkHours";
    if (template) {
      var requiredGroup = findByName(groups, template.group);
      var requiredZone = template.zone ? findByName(zones, template.zone) : null;
      if (!requiredGroup || !group || group.id !== requiredGroup.id) {
        showPolicyResult("The required live Geotab group \"" + template.group + "\" was not found or selected.", "error");
        return;
      }
      if (template.zone && (!requiredZone || !zone || zone.id !== requiredZone.id)) {
        showPolicyResult("The required live Geotab geofence \"" + template.zone + "\" was not found or selected.", "error");
        return;
      }
    }

    if (template && !template.trigger) {
      showPolicyResult("Full Use is unrestricted. Its roster was validated, but no Geotab exception rule is required.", "success");
      return;
    }
    if (!isTimePolicy && !zone) {
      showPolicyResult("Select the required Geotab zone first.", "error");
      return;
    }
    if (!group) {
      showPolicyResult("Select the required vehicle group. A policy is never applied company-wide automatically.", "error");
      return;
    }
    if (!name) {
      name = isTimePolicy ? "Time-Restricted Trade Staff" :
        (trigger === "OutsideArea" ? "Outside " : "Inside ") + (zone.name || "Geofence");
      byId("policy-name").value = name;
    }

    var action = isTimePolicy ? "during restricted weekday hours (04:00–18:00)" :
      trigger === "OutsideArea" ? "outside" : "inside";
    var confirmed = window.confirm(
      "Create the policy \"" + name + "\"?\n\n" +
      "It will trigger when vehicles in \"" + group.name + "\" are " + action +
      (isTimePolicy ? "." : " the \"" + zone.name + "\" geofence.")
    );
    if (!confirmed) return;

    var button = byId("create-policy-button");
    button.disabled = true;
    showPolicyResult("Checking existing Geotab rules...", "");
    try {
      var rules = await apiCall("Get", { typeName: "Rule" });
      var duplicate = (rules || []).find(function (rule) {
        return (rule.name || "").trim().toLowerCase() === name.toLowerCase();
      });
      if (duplicate) {
        showPolicyResult("A Geotab rule named \"" + name + "\" already exists. Nothing was created.", "error");
        return;
      }

      var condition;
      if (isTimePolicy) {
        var workTimeName = "Permitted evenings nights and weekends";
        var workTime = findByName(workTimes, workTimeName);
        if (!workTime) {
          var details = [];
          [1, 2, 3, 4, 5].forEach(function (day) {
            details.push({ dayOfWeek: day, fromTime: "00:00:00", toTime: "04:00:00" });
            details.push({ dayOfWeek: day, fromTime: "18:00:00", toTime: "23:59:59" });
          });
          [0, 6].forEach(function (day) {
            details.push({ dayOfWeek: day, fromTime: "00:00:00", toTime: "23:59:59" });
          });
          var workTimeId = await apiCall("Add", {
            typeName: "WorkTime",
            entity: { name: workTimeName, comment: "Created from Northland policy user guide", details: details }
          });
          workTime = { id: workTimeId, name: workTimeName };
          workTimes.push(workTime);
        }
        condition = { conditionType: "AfterRuleWorkHours", workTime: { id: workTime.id } };
      } else {
        condition = { conditionType: trigger, zone: { id: zone.id } };
      }

      var entity = {
        name: name,
        comment: isTimePolicy ? "Created from Northland policy user guide; permitted evenings, nights and weekends" :
          "Created by Live Geofence Monitor; attached zone: " + (zone.name || zone.id),
        baseType: "Custom",
        color: { r: 180, g: 35, b: 24, a: 255 },
        groups: [{ id: group.id }],
        condition: condition
      };
      var ruleId = await apiCall("Add", { typeName: "Rule", entity: entity });
      showPolicyResult(
        "Policy created successfully. Rule ID: " + ruleId + ". " +
        (isTimePolicy ? "The approved-hours schedule" : "Geofence \"" + zone.name + "\"") +
        " is attached to group \"" + group.name + "\".",
        "success"
      );
    } catch (error) {
      showPolicyResult("Policy could not be created: " + errorText(error) +
        ". Confirm your MyGeotab user can manage rules and work hours.", "error");
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
        ["Get", { typeName: "Group" }],
        ["Get", { typeName: "WorkTime" }]
      ]);
      zones = (result[0] || []).filter(function (zone) { return zoneCoordinates(zone).length >= 3; })
        .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
      devices = (result[1] || []).filter(function (device) { return device.id && device.name; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      groups = (result[2] || []).filter(function (group) { return group.id && group.name; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      workTimes = result[3] || [];
      populateSelect(byId("zone-select"), zones,
        zones.length ? "Select a Geotab zone" : "No accessible polygon zones", function (zone) { return zone.name || zone.id; });
      populateSelect(byId("group-select"), groups, "All accessible vehicles", function (group) { return group.name; });
      text("connection-text", "Connected to MyGeotab");
      byId("connection-dot").className = "dot online";
      showMessage(zones.length
        ? "Choose a zone, then refresh or start monitoring."
        : "No polygon zones are available to this user. Create a Zone in MyGeotab or check access permissions.", !zones.length);
      updatePolicyPreview();
      renderRows();
    } catch (error) {
      text("connection-text", "Connection error");
      byId("connection-dot").className = "dot error";
      showMessage("Could not load Geotab data: " + errorText(error), true);
    }
  }
  function bindEvents() {
    byId("refresh-button").addEventListener("click", refresh);
    byId("fit-map-button").addEventListener("click", function () { renderMap(true); });
    byId("monitor-button").addEventListener("click", function () { setMonitoring(!monitoring); });
    byId("create-policy-button").addEventListener("click", createPolicy);
    byId("policy-template").addEventListener("change", function () {
      showPolicyResult("", "");
      updatePolicyPreview();
    });
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
        initializeMap();
        loadReferenceData();
      },
      blur: function () {
        setMonitoring(false);
      }
    };
  };
}());
