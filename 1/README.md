# Live Geofence Monitor — MyGeotab Add-In

This package converts the supplied geofence dashboard into a MyGeotab Add-In.

## Live data used

- `Zone`: accessible Geotab geofence boundaries
- `Device`: accessible vehicles/assets
- `Group`: optional vehicle filtering
- `DeviceStatusInfo`: current position, position time, and speed
- `Rule`: policy creation with an `InsideArea` or `OutsideArea` zone condition

The add-in uses the session injected by MyGeotab. It contains no login form,
credentials, mock vehicles, sample positions, hardcoded geofences, or hardcoded
vehicle policy lists.

## Install

1. Host `geofence-monitor.html`, `geofence-monitor.css`, and
   `geofence-monitor.js` together on an HTTPS host that allows cross-origin
   access.
2. Edit `addin-config.template.json`:
   - replace `YOUR_SUPPORT_EMAIL_OR_URL`
   - replace `https://YOUR_HTTPS_HOST/geofence-monitor.html`
3. In MyGeotab, open **System > System Settings > Add-Ins**.
4. Enable unsigned add-ins if your organization permits them.
5. Paste the edited JSON configuration and save.
6. Refresh MyGeotab and open **Live Geofence Monitor** from the menu.

## Logic

Each refresh loads `DeviceStatusInfo`, joins it to the accessible `Device`
records by device ID, and evaluates longitude/latitude against the selected
Zone polygon using ray casting. A missing or zero coordinate is reported as
“No position”; it is never classified as inside or outside.

This is a current-position monitor. It does not claim historical entry/exit
events or duration outside a zone.

## Creating a policy

1. Select the Geotab zone.
2. Select a specific vehicle group.
3. Enter the policy name and choose whether it triggers inside or outside.
4. Select **Create and attach policy** and confirm the summary.

The add-in checks for an existing rule with the same name before calling
`Add` for a custom `Rule`. The rule condition references the selected Zone ID,
and the rule's groups list contains the selected Group ID. MyGeotab permissions
still control whether the signed-in user can create the rule.

### User-guide templates

The policy builder includes all six policies from `USER_GUIDE.txt`. It compares
the documented vehicle numbers with live Geotab device names and reports any
unmatched numbers before creation.

- Full Use validates its roster but creates no restriction rule.
- Northland, Whangarei, Hawkes Bay, and Napier create `OutsideArea` rules
  attached to the corresponding live Geotab Zone and Group.
- Time-Restricted Trade Staff creates or reuses a WorkTime covering 18:00–04:00
  on weekdays and all hours on weekends, then creates an
  `AfterRuleWorkHours` rule for the selected live Geotab Group.

Templates never create placeholder zones or vehicles. The matching Zone and
Group must already exist in MyGeotab.
