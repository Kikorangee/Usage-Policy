(function () {
  "use strict";

  window.geotab.addin.geofencePolicyNativeMap = function (element, service) {
    var policySelect = element.querySelector("#native-policy-select");
    var refreshButton = element.querySelector("#native-policy-refresh");
    var statusElement = element.querySelector("#native-map-status");
    var policies = [];
    var refreshSequence = 0;

    function setStatus(message, isError) {
      statusElement.textContent = message;
      statusElement.className = "status" + (isError ? " error" : "");
    }
    function activeFromDate() {
      var date = new Date();
      date.setFullYear(date.getFullYear() - 1);
      return date.toISOString();
    }
    function findCondition(condition, type) {
      if (!condition) return null;
      if (condition.conditionType === type) return condition;
      var children = condition.children || [];
      for (var index = 0; index < children.length; index += 1) {
        var match = findCondition(children[index], type);
        if (match) return match;
      }
      return null;
    }
    function zoneCondition(rule) {
      return findCondition(rule.condition, "OutsideArea") ||
        findCondition(rule.condition, "InsideArea");
    }
    function triggerType(rule) {
      if (findCondition(rule.condition, "OutsideArea")) return "OutsideArea";
      if (findCondition(rule.condition, "InsideArea")) return "InsideArea";
      return "";
    }
    function zonePoints(zone) {
      return (zone.points || []).map(function (point) {
        return {
          lat: Number(point.y != null ? point.y : point.latitude),
          lng: Number(point.x != null ? point.x : point.longitude)
        };
      }).filter(function (point) {
        return Number.isFinite(point.lat) && Number.isFinite(point.lng);
      });
    }
    function pointInsideZone(latitude, longitude, polygon) {
      var inside = false;
      for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        var xi = polygon[i].lng;
        var yi = polygon[i].lat;
        var xj = polygon[j].lng;
        var yj = polygon[j].lat;
        var intersects = ((yi > latitude) !== (yj > latitude)) &&
          (longitude < (xj - xi) * (latitude - yi) / (yj - yi) + xi);
        if (intersects) inside = !inside;
      }
      return inside;
    }
    function drawZone(zone, polygon) {
      if (polygon.length < 3) return;
      var path = [{
        type: "M",
        points: [{ lat: polygon[0].lat, lng: polygon[0].lng }]
      }];
      polygon.slice(1).forEach(function (point) {
        path.push({ type: "L", points: [{ lat: point.lat, lng: point.lng }] });
      });
      path.push({ type: "Z" });
      service.canvas.path(path, 100).change({
        fill: "#3157d5",
        stroke: "#2544aa",
        "stroke-width": 3,
        "fill-opacity": 0.15
      }).attach("over", function (position) {
        service.tooltip.showAt(position, {
          main: zone.name || "Selected geofence",
          secondary: ["Policy zone"]
        }, 1);
      }).attach("out", function () {
        service.tooltip.hide();
      });
    }
    function drawVehicle(row) {
      var color = row.triggered ? "#c62828" : "#15803d";
      service.canvas.circle({ lat: row.latitude, lng: row.longitude }, row.triggered ? 9 : 7, 120)
        .change({
          fill: color,
          stroke: "#ffffff",
          "stroke-width": 2,
          "fill-opacity": 1
        })
        .attach("over", function (position) {
          service.tooltip.showAt(position, {
            main: row.name,
            secondary: [
              row.triggered ? "Spatial policy trigger" : "Compliant",
              Math.round(row.speed || 0) + " km/h"
            ],
            additional: [
              row.latitude.toFixed(5) + ", " + row.longitude.toFixed(5)
            ]
          }, 2);
        })
        .attach("out", function () {
          service.tooltip.hide();
        });
    }
    function fitMap(polygon, rows) {
      var locations = polygon.slice();
      rows.forEach(function (row) {
        locations.push({ lat: row.latitude, lng: row.longitude });
      });
      if (!locations.length) return Promise.resolve(false);
      var latitudes = locations.map(function (point) { return point.lat; });
      var longitudes = locations.map(function (point) { return point.lng; });
      return service.map.setBounds({
        sw: { lat: Math.min.apply(Math, latitudes), lng: Math.min.apply(Math, longitudes) },
        ne: { lat: Math.max.apply(Math, latitudes), lng: Math.max.apply(Math, longitudes) }
      });
    }
    function renderSelectedPolicy() {
      var sequence = ++refreshSequence;
      var rule = policies.find(function (item) { return item.id === policySelect.value; });
      service.canvas.clear();
      if (!rule) {
        setStatus("Select a created policy.", false);
        return Promise.resolve();
      }
      var condition = zoneCondition(rule);
      if (!condition || !condition.zone || !condition.zone.id) {
        setStatus("The selected rule does not contain a supported Geotab zone condition.", true);
        return Promise.resolve();
      }
      var groupId = rule.groups && rule.groups[0] && rule.groups[0].id
        ? rule.groups[0].id
        : "GroupCompanyId";
      refreshButton.disabled = true;
      setStatus("Loading the selected Geotab zone and live vehicle positions…", false);
      return Promise.all([
        service.api.call("Get", {
          typeName: "Zone",
          search: { id: condition.zone.id }
        }),
        service.api.call("Get", {
          typeName: "Device",
          search: { groups: [{ id: groupId }], fromDate: activeFromDate() }
        }),
        service.api.call("Get", {
          typeName: "DeviceStatusInfo",
          search: { deviceSearch: { groups: [{ id: groupId }] } }
        })
      ]).then(function (results) {
        if (sequence !== refreshSequence) return;
        var zone = results[0][0];
        var devices = results[1] || [];
        var statuses = results[2] || [];
        if (!zone) throw new Error("The selected Geotab zone could not be loaded.");
        var names = {};
        devices.forEach(function (device) { names[device.id] = device.name || device.id; });
        var polygon = zonePoints(zone);
        var spatialTrigger = triggerType(rule);
        var rows = statuses.map(function (item) {
          var latitude = Number(item.latitude);
          var longitude = Number(item.longitude);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
          var inside = pointInsideZone(latitude, longitude, polygon);
          return {
            name: names[item.device && item.device.id] || (item.device && item.device.id) || "Vehicle",
            latitude: latitude,
            longitude: longitude,
            speed: Number(item.speed || 0),
            triggered: spatialTrigger === "OutsideArea" ? !inside : inside
          };
        }).filter(function (item) { return item !== null; });
        drawZone(zone, polygon);
        rows.forEach(drawVehicle);
        return fitMap(polygon, rows).then(function () {
          var triggerCount = rows.filter(function (row) { return row.triggered; }).length;
          setStatus(
            rule.name + ": " + rows.length + " positioned vehicle(s), " +
            triggerCount + " spatial trigger(s). Geotab continues to evaluate the complete rule schedule.",
            false
          );
        });
      }).catch(function (error) {
        setStatus("Could not render the native policy map: " +
          (error && error.message ? error.message : String(error)), true);
      }).then(function () {
        refreshButton.disabled = false;
      });
    }
    function loadPolicies() {
      refreshButton.disabled = true;
      setStatus("Loading policies from Geotab…", false);
      return service.api.call("Get", {
        typeName: "Rule",
        search: { baseType: "Custom" }
      }).then(function (rules) {
        policies = (rules || []).filter(function (rule) {
          return (rule.comment || "").indexOf("Created by Live Geofence Monitor") !== -1;
        }).sort(function (a, b) {
          return (a.name || "").localeCompare(b.name || "");
        });
        policySelect.innerHTML = "";
        var placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = policies.length ? "Select a created policy" : "No created policies found";
        policySelect.appendChild(placeholder);
        policies.forEach(function (rule) {
          var option = document.createElement("option");
          option.value = rule.id;
          option.textContent = rule.name || rule.id;
          policySelect.appendChild(option);
        });
        setStatus(policies.length + " created polic" +
          (policies.length === 1 ? "y" : "ies") + " available.", false);
      }).catch(function (error) {
        setStatus("Could not load Geotab policies: " +
          (error && error.message ? error.message : String(error)), true);
      }).then(function () {
        refreshButton.disabled = false;
      });
    }

    policySelect.addEventListener("change", renderSelectedPolicy);
    refreshButton.addEventListener("click", function () {
      if (policySelect.value) renderSelectedPolicy();
      else loadPolicies();
    });
    service.page.attach("focus", loadPolicies);
    service.page.attach("blur", function () {
      service.canvas.clear();
      service.tooltip.hide();
    });
    loadPolicies();
  };
}());
