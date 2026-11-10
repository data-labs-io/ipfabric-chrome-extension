// diff-content.js — IP Fabric Diff Dashboard
// =============================================================================
// Overlays a native-looking "Diff Dashboard" tool onto IP Fabric Technology and
// Inventory table views. The user picks ONE column of the currently-displayed
// table and ONE other snapshot; the extension then computes, live from the IP
// Fabric API, exactly what was ADDED, REMOVED, or CHANGED in that column
// between the current snapshot and the chosen snapshot.
//
// Why a content script (not a background fetch): running here, in the host
// page's context, means every fetch() to the IP Fabric API automatically
// carries the user's existing session cookie — no API token, no CORS dance.
// This mirrors the "Cycle every table" mode of the companion Global Search
// extension, whose verified request shapes this tool reuses verbatim:
//
//   • snapshot list : GET  /api/snapshots                       (cookie auth)
//   • table data    : POST /api/tables/<path>                   (cookie auth)
//        body: { snapshot, columns, filters, pagination, reports }
//
// The compare semantics mirror the IP Fabric Python SDK's
// `<table>.compare(snapshot_id=..., unique_keys=[...], columns=[...])`:
// rows are matched by a per-table primary key (unique_keys); for the selected
// column, a matched row whose value differs is "changed", and unmatched rows
// are "added"/"removed".
//
// The UI lives in a Shadow DOM host so the host page's CSS can never leak in
// (and ours never leaks out). It is styled to read as part of the IP Fabric
// platform and docks itself into the free space above the data table.
// =============================================================================

(() => {
  "use strict";
  if (window.__ipfSnapshotDiffInstalled) return;
  window.__ipfSnapshotDiffInstalled = true;

  /* ===========================================================================
   * 0. Constants & brand
   * ========================================================================= */

  const BRAND = {
    bar:      "#254083", // IP Fabric header indigo
    barDeep:  "#1d3469",
    navy:     "#143352",
    magenta:  "#c01f60",
    gray:     "#8d999b",
    added:    "#1a7f37", // green  (present now / only in A)
    addedBg:  "#dafbe1",
    removed:  "#cf222e", // red    (gone / only in B)
    removedBg:"#ffebe9",
    changed:  "#9a6700", // amber  (value differs)
    changedBg:"#fff8c5",
  };

  const STORE = {
    rect:      "snapdiff_rect",       // {top,left,width,height}
    collapsed: "snapdiff_collapsed",  // bool
    hidden:    "snapdiff_hidden",     // bool (panel open/closed)
    ignoreVol: "snapdiff_ignore_volatile", // bool
    // Options → Display toggle for the whole Diff Dashboard feature (the
    // header-row launcher + panel). Named like the companion extension's
    // showGlobalSearch / showLlmSession / showCveStatus keys so all four
    // overlays are controlled the same way.
    feature:   "showDiffDashboard",   // bool (default true)
  };

  const PAGE_LIMIT = 5000;     // rows per API page
  const ROW_CAP    = 100000;   // hard safety cap on rows fetched per snapshot
  const FETCH_TIMEOUT_MS = 30000;

  /* ===========================================================================
   * 1. UI-path → API-path mapping  (ground truth, reused from the shipped
   *    Global Search extension's content.js — do NOT guess these)
   * ========================================================================= */

  const API_PATH_OVERRIDES = {
    "/technology/vlans/network-summary": ["/api/tables/vlan/network-summary"],
    "/technology/vlans/site-summary":    ["/api/tables/vlan/site-summary"],
    "/technology/vlans/l3-gateways":     ["/api/tables/vlan/l3-gateways"],
    "/technology/vlans/device-detail":   ["/api/tables/vlan/device"],
    "/technology/vlans/device-summary":  ["/api/tables/vlan/device-summary"],
    "/technology/routing/routes":        ["/api/tables/networks/routes"],
    "/technology/routing/routes/ipv6":   ["/api/tables/networks/ipv6-routes", "/api/tables/networks/routesV6", "/api/tables/networks/routes/ipv6"],
    "/inventory/hosts":                  ["/api/tables/addressing/hosts"],
    "/inventory/hosts/ipv6":             ["/api/tables/addressing/ipv6-hosts", "/api/tables/addressing/hosts-ipv6", "/api/tables/addressing/hostsV6", "/api/tables/addressing/hosts/ipv6"],
    "/technology/load-balancing/virtual-servers-pools":       ["/api/tables/load-balancing/virtual-servers-pools", "/api/tables/load-balancing/virtual-servers/pools"],
    "/technology/load-balancing/virtual-servers-pool-members":["/api/tables/load-balancing/virtual-servers-pool-members", "/api/tables/load-balancing/virtual-servers/pool-members"],
    "/technology/load-balancing/virtual-servers-path-rules":  ["/api/tables/load-balancing/virtual-servers-path-rules", "/api/tables/load-balancing/virtual-servers/path-rules"],
    "/technology/load-balancing/virtual-servers-certs":       ["/api/tables/load-balancing/virtual-servers-certs", "/api/tables/load-balancing/virtual-servers-certificates", "/api/tables/load-balancing/virtual-servers/certificates"],
    // --- v5.1.0: reconciled from IP Fabric webPages.yaml (authoritative table catalog) ---
    "/inventory/devices/families-2": ["/api/tables/inventory/summary/families"],
    "/inventory/devices/models-2": ["/api/tables/inventory/summary/models"],
    "/inventory/devices/platforms-2": ["/api/tables/inventory/summary/platforms"],
    "/inventory/devices/vendors-2": ["/api/tables/inventory/summary/vendors"],
    "/inventory/end-of-life-milestones": ["/api/tables/reports/eof/summary"],
    "/inventory/end-of-life-milestones/detail": ["/api/tables/reports/eof/detail"],
    "/inventory/end-of-life-milestones/summary": ["/api/tables/reports/eof/summary"],
    "/inventory/hosts/virtual-machines": ["/api/tables/inventory/virtual-machines/inventory"],
    "/inventory/hosts/virtual-machines-interfaces": ["/api/tables/inventory/virtual-machines/virtual-machines-interfaces"],
    "/inventory/os-versions": ["/api/tables/inventory/os-version-consistency/platforms"],
    "/inventory/os-versions/models": ["/api/tables/inventory/os-version-consistency/models"],
    "/inventory/os-versions/platforms": ["/api/tables/inventory/os-version-consistency/platforms"],
    "/inventory/part-numbers-2": ["/api/tables/inventory/pn"],
    "/management/discovery-history": ["/api/tables/inventory/discovery-history"],
    "/settings/administration/license-consumption": ["/api/tables/settings/administration/license-consumption/overview"],
    "/settings/administration/license-consumption/cloud-constructs": ["/api/tables/settings/administration/license-consumption/cloud-constructs"],
    "/settings/administration/license-consumption/on-prem-devices": ["/api/tables/settings/administration/license-consumption/on-prem-devices"],
    "/settings/administration/license-consumption/overview": ["/api/tables/settings/administration/license-consumption/overview"],
    "/technology/addressing/arp-table-2": ["/api/tables/addressing/arp"],
    "/technology/addressing/ipv6-neighbor-discovery": ["/api/tables/addressing/ipv6-neighbors"],
    "/technology/addressing/mac-table-2": ["/api/tables/addressing/mac"],
    "/technology/addressing/managed-duplicate-ip": ["/api/tables/addressing/duplicate-ip"],
    "/technology/addressing/managed-ip": ["/api/tables/addressing/managed-devs"],
    "/technology/addressing/managed-ip/ipv4-managed-ip": ["/api/tables/addressing/managed-devs"],
    "/technology/addressing/managed-ip/ipv4-managed-ip-summary": ["/api/tables/addressing/ipv4-managed-ip-summary"],
    "/technology/addressing/managed-ip/ipv6-managed-ip": ["/api/tables/addressing/ipv6-managed-devs"],
    "/technology/addressing/managed-ip/ipv6-managed-ip-summary": ["/api/tables/addressing/ipv6-managed-ip-summary"],
    "/technology/addressing/nat-2": ["/api/tables/security/nat44"],
    "/technology/cdp-lldp/all-neighbors-2": ["/api/tables/neighbors/all"],
    "/technology/cdp-lldp/endpoints-neighbors": ["/api/tables/neighbors/endpoints"],
    "/technology/cdp-lldp/unidirectional-neighbors-2": ["/api/tables/neighbors/unidirectional"],
    "/technology/cdp-lldp/unmanaged-neighbors-2": ["/api/tables/neighbors/unmanaged"],
    "/technology/cloud": ["/api/tables/cloud/network-interfaces"],
    "/technology/cloud/endpoints": ["/api/tables/cloud/endpoints/virtual-machines"],
    "/technology/cloud/nat-gateways": ["/api/tables/cloud/nat-gateways/inventory"],
    "/technology/cloud/nat-gateways/inventory": ["/api/tables/cloud/nat-gateways/inventory"],
    "/technology/cloud/nat-gateways/rules": ["/api/tables/cloud/nat-gateways/rules"],
    "/technology/cloud/networks": ["/api/tables/cloud/networks/inventory"],
    "/technology/cloud/nodes": ["/api/tables/cloud/nodes/inventory"],
    "/technology/cloud/private-link": ["/api/tables/cloud/private-link/endpoints"],
    "/technology/cloud/private-link/services": ["/api/tables/cloud/private-link/services/inventory"],
    "/technology/cloud/public-ips/ip-addresses": ["/api/tables/cloud/public-ips/ipv4-addresses"],
    "/technology/cloud/public-ips/ip-addresses/ipv4": ["/api/tables/cloud/public-ips/ipv4-addresses"],
    "/technology/cloud/public-ips/ip-addresses/ipv6": ["/api/tables/cloud/public-ips/ipv6-addresses"],
    "/technology/cloud/route-tables": ["/api/tables/cloud/route-tables/inventory"],
    "/technology/cloud/security": ["/api/tables/cloud/security/inventory"],
    "/technology/cloud/security-addresses": ["/api/tables/cloud/security-addresses/inventory"],
    "/technology/cloud/security/inventory": ["/api/tables/cloud/security/inventory"],
    "/technology/cloud/subnets": ["/api/tables/cloud/subnets/inventory"],
    "/technology/cloud/vendors/aws": ["/api/tables/cloud/vendors/aws/inventory"],
    "/technology/cloud/vendors/aws/internet-gateways": ["/api/tables/cloud/vendors/aws/internet-gateways"],
    "/technology/cloud/vendors/aws/private-link": ["/api/tables/cloud/vendors/aws/private-link/vpc-endpoints"],
    "/technology/cloud/vendors/azure": ["/api/tables/cloud/vendors/azure/inventory"],
    "/technology/cloud/vendors/azure/dns": ["/api/tables/cloud/vendors/azure/dns/vnet"],
    "/technology/cloud/vendors/azure/private-link": ["/api/tables/cloud/vendors/azure/private-link/endpoints"],
    "/technology/cloud/vendors/azure/vnet-integration": ["/api/tables/cloud/vendors/azure/vnet-integration/app-services"],
    "/technology/cloud/vendors/gcp": ["/api/tables/cloud/vendors/gcp/inventory"],
    "/technology/cloud/vendors/gcp/private-service-connect": ["/api/tables/cloud/vendors/gcp/private-service-connect/endpoints"],
    "/technology/cloud/vendors/gcp/serverless-services": ["/api/tables/cloud/vendors/gcp/serverless-services/app-engine"],
    "/technology/dhcp/relay": ["/api/tables/dhcp/relay/interfaces"],
    "/technology/dhcp/relay/global-stats": ["/api/tables/dhcp/relay/global-stats/summary"],
    "/technology/dhcp/relay/interfaces-stats": ["/api/tables/dhcp/relay/interfaces-stats/received"],
    "/technology/dhcp/server": ["/api/tables/dhcp/server/summary"],
    "/technology/fhrp/active-gateway-balancing": ["/api/tables/fhrp/balancing"],
    "/technology/fhrp/active-gateway-root-alignment": ["/api/tables/fhrp/stproot-alignment"],
    "/technology/fhrp/virtual-gateways": ["/api/tables/fhrp/virtual-gateways"],
    "/technology/interfaces/connectivity-matrix/unmanaged-neighbors-detail": ["/api/tables/interfaces/connectivity-matrix/unmanaged-neighbors/detail"],
    "/technology/interfaces/connectivity-matrix/unmanaged-neighbors-summary": ["/api/tables/interfaces/connectivity-matrix/unmanaged-neighbors/summary"],
    "/technology/interfaces/counters": ["/api/tables/interfaces/counters/inbound"],
    "/technology/interfaces/errdisabled": ["/api/tables/interfaces/errors/disabled"],
    "/technology/interfaces/rate": ["/api/tables/interfaces/load/inbound"],
    "/technology/interfaces/rate/bidirectional": ["/api/tables/interfaces/load/bidirectional"],
    "/technology/interfaces/rate/inbound": ["/api/tables/interfaces/load/inbound"],
    "/technology/interfaces/rate/outbound": ["/api/tables/interfaces/load/outbound"],
    "/technology/interfaces/storm-control": ["/api/tables/interfaces/storm-control/broadcast"],
    "/technology/interfaces/switchport-2": ["/api/tables/interfaces/switchports"],
    "/technology/interfaces/transceivers": ["/api/tables/interfaces/transceivers/inventory"],
    "/technology/interfaces/tunnels": ["/api/tables/interfaces/tunnels/ipv4"],
    "/technology/ip-telephony/phones": ["/api/tables/inventory/phones"],
    "/technology/load-balancing": ["/api/tables/load-balancing/virtual-servers"],
    "/technology/management/aaa": ["/api/tables/security/aaa/servers"],
    "/technology/management/aaa/accounting": ["/api/tables/security/aaa/accounting"],
    "/technology/management/aaa/authentication": ["/api/tables/security/aaa/authentication"],
    "/technology/management/aaa/authorization": ["/api/tables/security/aaa/authorization"],
    "/technology/management/aaa/lines": ["/api/tables/security/aaa/lines"],
    "/technology/management/aaa/local-users": ["/api/tables/security/aaa/users"],
    "/technology/management/aaa/password-strength": ["/api/tables/security/aaa/password-strength"],
    "/technology/management/aaa/servers": ["/api/tables/security/aaa/servers"],
    "/technology/management/banners": ["/api/tables/management/banners/summary"],
    "/technology/management/dns": ["/api/tables/management/dns/settings"],
    "/technology/management/flow": ["/api/tables/management/flow/overview"],
    "/technology/management/flow/netflow-collectors": ["/api/tables/management/flow/netflow/collectors"],
    "/technology/management/flow/netflow-devices": ["/api/tables/management/flow/netflow/devices"],
    "/technology/management/flow/netflow-interfaces": ["/api/tables/management/flow/netflow/interfaces"],
    "/technology/management/flow/sflow-collectors": ["/api/tables/management/flow/sflow/collectors"],
    "/technology/management/flow/sflow-data-sources": ["/api/tables/management/flow/sflow/sources"],
    "/technology/management/flow/sflow-devices": ["/api/tables/management/flow/sflow/devices"],
    "/technology/management/licenses/cisco-smart-license": ["/api/tables/management/licenses/cisco-smart-licenses/authorization"],
    "/technology/management/licenses/cisco-smart-license/registration-2": ["/api/tables/management/licenses/cisco-smart-licenses/registration"],
    "/technology/management/licenses/cisco-smart-license/reservations-2": ["/api/tables/management/licenses/cisco-smart-licenses/reservations"],
    "/technology/management/licenses/license": ["/api/tables/management/licenses/summary"],
    "/technology/management/licenses/license/license-detail": ["/api/tables/management/licenses/detail"],
    "/technology/management/logging": ["/api/tables/management/logging/summary"],
    "/technology/management/ntp": ["/api/tables/management/ntp/summary"],
    "/technology/management/ptp": ["/api/tables/management/ptp/local-clock"],
    "/technology/management/snmp": ["/api/tables/management/snmp/summary"],
    "/technology/management/telnet-access-2": ["/api/tables/security/enabled-telnet"],
    "/technology/mpls/l2vpn": ["/api/tables/mpls/l2-vpn/point-to-point-vpws"],
    "/technology/mpls/l3vpn": ["/api/tables/mpls/l3-vpn/pe-routers"],
    "/technology/mpls/ldp": ["/api/tables/mpls/ldp/neighbors"],
    "/technology/mpls/rsvp": ["/api/tables/mpls/rsvp/neighbors"],
    "/technology/multicast/igmp": ["/api/tables/multicast/igmp/groups"],
    "/technology/multicast/igmp/snooping": ["/api/tables/multicast/igmp/snooping/global"],
    "/technology/multicast/mac": ["/api/tables/multicast/mac"],
    "/technology/multicast/mroute": ["/api/tables/multicast/routes/overview"],
    "/technology/multicast/mroute/first-hop-router": ["/api/tables/multicast/routes/first-hop-router"],
    "/technology/multicast/mroute/mroute-counters": ["/api/tables/multicast/routes/counters"],
    "/technology/multicast/mroute/mroute-table": ["/api/tables/multicast/routes/table"],
    "/technology/multicast/mroute/oil-detail": ["/api/tables/multicast/routes/outgoing-interfaces"],
    "/technology/multicast/mroute/overview": ["/api/tables/multicast/routes/overview"],
    "/technology/multicast/mroute/sources": ["/api/tables/multicast/routes/sources"],
    "/technology/multicast/pim": ["/api/tables/multicast/pim/neighbors"],
    "/technology/multicast/rp": ["/api/tables/multicast/pim/rp/overview"],
    "/technology/multicast/rp/bsr": ["/api/tables/multicast/pim/rp/bsr"],
    "/technology/multicast/rp/rp-mappings": ["/api/tables/multicast/pim/rp/mappings"],
    "/technology/multicast/rp/rp-mappings-groups": ["/api/tables/multicast/pim/rp/mappings-groups"],
    "/technology/multicast/rp/rp-overview": ["/api/tables/multicast/pim/rp/overview"],
    "/technology/oam/udld": ["/api/tables/management/oam/unidirectional-link-detection/neighbors"],
    "/technology/oam/udld/interfaces": ["/api/tables/management/oam/unidirectional-link-detection/interfaces"],
    "/technology/oam/udld/neighbors": ["/api/tables/management/oam/unidirectional-link-detection/neighbors"],
    "/technology/platforms/cisco-fabric-path": ["/api/tables/platforms/fabric-path/summary"],
    "/technology/platforms/cisco-fabric-path/is-is-neighbors": ["/api/tables/platforms/fabric-path/neighbors"],
    "/technology/platforms/cisco-fabric-path/routes": ["/api/tables/platforms/fabric-path/routes"],
    "/technology/platforms/cisco-fabric-path/summary": ["/api/tables/platforms/fabric-path/summary"],
    "/technology/platforms/cisco-fabric-path/switch-ids": ["/api/tables/platforms/fabric-path/switches"],
    "/technology/platforms/cluster": ["/api/tables/platforms/cluster/srx"],
    "/technology/platforms/environment": ["/api/tables/inventory/power-supplies"],
    "/technology/platforms/environment/fans": ["/api/tables/inventory/fans"],
    "/technology/platforms/environment/modules": ["/api/tables/inventory/modules"],
    "/technology/platforms/environment/power-supplies": ["/api/tables/inventory/power-supplies"],
    "/technology/platforms/environment/power-supplies-fans": ["/api/tables/inventory/power-supplies-fans"],
    "/technology/platforms/environment/temperature-sensors": ["/api/tables/inventory/temperature-sensors"],
    "/technology/platforms/fex": ["/api/tables/platforms/fex/modules"],
    "/technology/platforms/logical-devices": ["/api/tables/platforms/devices"],
    "/technology/platforms/poe": ["/api/tables/platforms/poe/devices"],
    "/technology/platforms/vss": ["/api/tables/platforms/vss/overview"],
    "/technology/port-channels/inbound-balancing-table": ["/api/tables/interfaces/port-channel/balance/inbound"],
    "/technology/port-channels/member-status-table": ["/api/tables/interfaces/port-channel/member-status"],
    "/technology/port-channels/mlag": ["/api/tables/platforms/mlag/switches"],
    "/technology/port-channels/mlag/cisco-vpc": ["/api/tables/platforms/mlag/vpc"],
    "/technology/port-channels/mlag/pairs": ["/api/tables/platforms/mlag/pairs"],
    "/technology/port-channels/mlag/peer-links": ["/api/tables/platforms/mlag/peers"],
    "/technology/port-channels/mlag/switches": ["/api/tables/platforms/mlag/switches"],
    "/technology/port-channels/outbound-balancing-table": ["/api/tables/interfaces/port-channel/balance/outbound"],
    "/technology/qos": ["/api/tables/qos/policy-maps"],
    "/technology/routing": ["/api/tables/networks/policies/routing"],
    "/technology/routing/bgp": ["/api/tables/routing/protocols/bgp/neighbors"],
    "/technology/routing/bgp/address-families": ["/api/tables/routing/protocols/bgp/address-families"],
    "/technology/routing/bgp/advertised-routes": ["/api/tables/routing/protocols/bgp/routes"],
    "/technology/routing/bgp/advertised-routes-ipv6": ["/api/tables/routing/protocols/bgp/routesIpv6"],
    "/technology/routing/bgp/neighbors": ["/api/tables/routing/protocols/bgp/neighbors"],
    "/technology/routing/eigrp": ["/api/tables/routing/protocols/eigrp/neighbors"],
    "/technology/routing/eigrp/interfaces": ["/api/tables/routing/protocols/eigrp/interfaces"],
    "/technology/routing/eigrp/neighbors": ["/api/tables/routing/protocols/eigrp/neighbors"],
    "/technology/routing/is-is": ["/api/tables/routing/protocols/is-is/neighbors"],
    "/technology/routing/is-is/interfaces": ["/api/tables/routing/protocols/is-is/interfaces"],
    "/technology/routing/is-is/levels": ["/api/tables/routing/protocols/is-is/levels"],
    "/technology/routing/is-is/neighbors": ["/api/tables/routing/protocols/is-is/neighbors"],
    "/technology/routing/lisp/map-resolvers": ["/api/tables/routing/protocols/lisp/ipv4-databases"],
    "/technology/routing/lisp/map-resolvers/ipv4": ["/api/tables/routing/protocols/lisp/ipv4-databases"],
    "/technology/routing/lisp/map-resolvers/ipv6": ["/api/tables/routing/protocols/lisp/ipv6-databases"],
    "/technology/routing/lisp/routes": ["/api/tables/routing/protocols/lisp/ipv4-routes"],
    "/technology/routing/lisp/routes/ipv4": ["/api/tables/routing/protocols/lisp/ipv4-routes"],
    "/technology/routing/lisp/routes/ipv6": ["/api/tables/routing/protocols/lisp/ipv6-routes"],
    "/technology/routing/ospf": ["/api/tables/routing/protocols/ospf/neighbors"],
    "/technology/routing/ospf-v3": ["/api/tables/routing/protocols/ospf-v3/neighbors"],
    "/technology/routing/ospf-v3/interfaces": ["/api/tables/routing/protocols/ospf-v3/interfaces"],
    "/technology/routing/ospf-v3/neighbors": ["/api/tables/routing/protocols/ospf-v3/neighbors"],
    "/technology/routing/ospf/interfaces": ["/api/tables/routing/protocols/ospf/interfaces"],
    "/technology/routing/ospf/neighbors": ["/api/tables/routing/protocols/ospf/neighbors"],
    "/technology/routing/path-verifications-2": ["/api/tables/networks/path-lookup-checks"],
    "/technology/routing/pbr-interfaces": ["/api/tables/networks/policies/routing/interfaces"],
    "/technology/routing/policy-based-routing": ["/api/tables/security/pbr"],
    "/technology/routing/prefix-lists": ["/api/tables/networks/policies/prefix-lists/ipv4"],
    "/technology/routing/prefix-lists/ipv4": ["/api/tables/networks/policies/prefix-lists/ipv4"],
    "/technology/routing/prefix-lists/ipv6": ["/api/tables/networks/policies/prefix-lists/ipv6"],
    "/technology/routing/rip": ["/api/tables/routing/protocols/rip/neighbors"],
    "/technology/routing/rip/interfaces": ["/api/tables/routing/protocols/rip/interfaces"],
    "/technology/routing/rip/neighbors": ["/api/tables/routing/protocols/rip/neighbors"],
    "/technology/routing/route-stability-2": ["/api/tables/networks/route-stability"],
    "/technology/routing/routing-policies": ["/api/tables/networks/policies/routing"],
    "/technology/routing/summary": ["/api/tables/networks/summary/protocols"],
    "/technology/routing/summary/bgp": ["/api/tables/networks/summary/protocols/bgp"],
    "/technology/routing/summary/eigrp": ["/api/tables/networks/summary/protocols/eigrp"],
    "/technology/routing/summary/is-is": ["/api/tables/networks/summary/protocols/isis"],
    "/technology/routing/summary/ospf": ["/api/tables/networks/summary/protocols/ospf"],
    "/technology/routing/summary/ospfv3": ["/api/tables/networks/summary/protocols/ospfv3"],
    "/technology/routing/summary/protocols": ["/api/tables/networks/summary/protocols"],
    "/technology/routing/summary/rip": ["/api/tables/networks/summary/protocols/rip"],
    "/technology/routing/vrf": ["/api/tables/vrf/summary"],
    "/technology/routing/vrf/detail": ["/api/tables/vrf/detail"],
    "/technology/routing/vrf/interfaces": ["/api/tables/vrf/interfaces"],
    "/technology/routing/vrf/summary": ["/api/tables/vrf/summary"],
    "/technology/sdn/aci": ["/api/tables/aci/endpoints"],
    "/technology/sdn/aci/dtep": ["/api/tables/aci/dtep"],
    "/technology/sdn/aci/endpoint": ["/api/tables/aci/endpoints"],
    "/technology/sdn/aci/vlan": ["/api/tables/aci/vlan"],
    "/technology/sdn/aci/vrf": ["/api/tables/aci/vrf"],
    "/technology/sdn/apic": ["/api/tables/apic/controllers"],
    "/technology/sdn/apic/applications": ["/api/tables/apic/applications"],
    "/technology/sdn/apic/bridge-domains": ["/api/tables/apic/bridge-domains"],
    "/technology/sdn/apic/contexts": ["/api/tables/apic/contexts"],
    "/technology/sdn/apic/contracts": ["/api/tables/apic/contracts"],
    "/technology/sdn/apic/controllers": ["/api/tables/apic/controllers"],
    "/technology/sdn/apic/endpoint-groups": ["/api/tables/apic/endpoint-groups"],
    "/technology/sdn/apic/endpoint-groups-contracts": ["/api/tables/apic/endpoint-groups/contracts"],
    "/technology/sdn/apic/service-graphs": ["/api/tables/apic/service-graphs"],
    "/technology/sdn/vxlan": ["/api/tables/vxlan/vtep"],
    "/technology/sdn/vxlan/interfaces": ["/api/tables/vxlan/interfaces"],
    "/technology/sdn/vxlan/peers": ["/api/tables/vxlan/peers"],
    "/technology/sdn/vxlan/vni": ["/api/tables/vxlan/vni"],
    "/technology/sdn/vxlan/vtep": ["/api/tables/vxlan/vtep"],
    "/technology/sdwan/meraki": ["/api/tables/sdwan/meraki/overlay"],
    "/technology/sdwan/silverpeak": ["/api/tables/sdwan/silverpeak/overlay"],
    "/technology/sdwan/velocloud": ["/api/tables/sdwan/velocloud/overlay"],
    "/technology/sdwan/versa": ["/api/tables/sdwan/versa/sites"],
    "/technology/sdwan/viptela": ["/api/tables/sdwan/viptela/bfd-sessions"],
    "/technology/security": ["/api/tables/security/acl"],
    "/technology/security/acl-interfaces": ["/api/tables/security/acl/interfaces"],
    "/technology/security/dhcp-snooping": ["/api/tables/security/dhcp/snooping"],
    "/technology/security/dhcp-snooping/binding-database": ["/api/tables/security/dhcp/bindings"],
    "/technology/security/dhcp-snooping/configuration": ["/api/tables/security/dhcp/snooping"],
    "/technology/security/dmvpn": ["/api/tables/security/dmvpn"],
    "/technology/security/global-acl-policies": ["/api/tables/security/acl/global-policies"],
    "/technology/security/ipsec": ["/api/tables/security/ipsec/tunnels"],
    "/technology/security/lsvpn": ["/api/tables/security/lsvpn/satellites"],
    "/technology/security/secure-ports": ["/api/tables/security/secure-ports/devices"],
    "/technology/security/ssl": ["/api/tables/security/ssl/certificates"],
    "/technology/security/zone-firewall": ["/api/tables/security/zone-firewall/policies"],
    "/technology/serial-ports": ["/api/tables/serial-ports"],
    "/technology/spanning-tree/inconsistencies": ["/api/tables/spanning-tree/inconsistencies/neighbor-ports-vlan-mismatch"],
    "/technology/spanning-tree/inconsistencies/vlans-no-stp": ["/api/tables/interfaces/inconsistencies/summary"],
    "/technology/spanning-tree/inconsistencies/vlans-no-stp/detail": ["/api/tables/interfaces/inconsistencies/details"],
    "/technology/spanning-tree/inconsistencies/vlans-no-stp/summary": ["/api/tables/interfaces/inconsistencies/summary"],
    "/technology/spanning-tree/stp-bridges": ["/api/tables/spanning-tree/bridges"],
    "/technology/spanning-tree/stp-guards": ["/api/tables/spanning-tree/guards"],
    "/technology/spanning-tree/stp-instances": ["/api/tables/spanning-tree/instances"],
    "/technology/spanning-tree/stp-neighbors": ["/api/tables/spanning-tree/neighbors"],
    "/technology/spanning-tree/stp-virtual-ports": ["/api/tables/spanning-tree/ports"],
    "/technology/spanning-tree/stp-vlans": ["/api/tables/spanning-tree/vlans"],
    "/technology/spbm/b-mac-forwarding": ["/api/tables/spbm/bmac"],
    "/technology/spbm/services": ["/api/tables/spbm/services"],
    "/technology/vlans": ["/api/tables/vlan/device-summary"],
    "/technology/wireless/access-points": ["/api/tables/wireless/access-points"],
    "/technology/wireless/clients": ["/api/tables/wireless/clients"],
    "/technology/wireless/controllers": ["/api/tables/wireless/controllers"],
    "/technology/wireless/radios": ["/api/tables/wireless/radio"],
    "/technology/wireless/radios/radios-detail": ["/api/tables/wireless/radio"],
    "/technology/wireless/radios/ssid-summary": ["/api/tables/wireless/ssid-summary"],
  };

  // Documented explicit column lists for specific tables, tried first so key
  // fields are always present even on zero-row snapshots.
  const TABLE_COLUMN_OVERRIDES = {
    "/technology/vlans/network-summary": ["vlanId", "vlanName", "devCount", "dscr"],
    "/technology/vlans/site-summary":    ["vlanId", "vlanName", "siteName", "devCount", "dscr"],
    "/technology/vlans/l3-gateways":     ["vlanId", "networks", "stpDomain", "rootId"],
    "/technology/vlans/device-detail":   ["vlanId", "vlanName", "hostname", "siteName", "sn", "status", "stdStatus", "stpDomain"],
    "/technology/routing/routes":        ["network", "prefix", "protocol", "nexthop", "hostname", "siteName", "vrf"],
    "/technology/routing/routes/ipv6":   ["network", "prefix", "protocol", "nexthop", "hostname", "siteName", "vrf"],
  };

  const COMMON_COLUMNS = [
    "id", "hostname", "name", "siteName", "sn", "snHw", "intName",
    "loginIpv4", "loginIp", "ip", "ipv4", "ipv6",
    "vendor", "family", "model", "platform", "version",
    "vlanId", "vlanName", "vrf", "mac", "address",
    "neighborHostname", "neighborSn", "remoteHostname",
    "dnsName", "uri", "url", "description", "dscr", "title",
    "devCount", "stpDomain", "rootId", "networks", "status", "stdStatus",
    "network", "prefix", "prefixLength", "nexthop", "nhCount", "protocol",
    "poolName", "poolMemberName", "memberIp", "memberIpV6", "availability", "state", "port",
  ];

  // Map a UI path to an ordered list of probable API paths. Reused verbatim
  // from the shipped Global Search content.js (verified against the live API).
  function uiPathToApi(uiPath) {
    const parts = uiPath.split("/").filter(Boolean);
    if (!parts.length) return [];
    const head = parts[0];
    const tail = parts.slice(1);

    function basePath(t) {
      if (head === "technology") return "/api/tables/" + t.join("/");
      if (head === "inventory")  return "/api/tables/inventory/" + t.join("/");
      return "/api/tables/" + parts.join("/");
    }

    const candidates = [];
    const overrides = API_PATH_OVERRIDES[uiPath];
    if (overrides) candidates.push(...overrides);
    if (tail.length || head !== "inventory") candidates.push(basePath(tail));
    if (head === "inventory") candidates.push("/api/tables/" + tail.join("/"));

    const hyphenVariants = candidates.flatMap((p) => {
      const h = p.replace(/\/l3vpn\b/g, "/l3-vpn").replace(/\/l2vpn\b/g, "/l2-vpn");
      return h !== p ? [h] : [];
    });
    candidates.push(...hyphenVariants);

    const sectionVariants = [];
    for (const p of candidates) {
      const m = p.match(/^(\/api\/tables\/)([^/]+)(\/.*)?$/);
      if (!m) continue;
      const [, prefix, section, rest = ""] = m;
      const alts = new Set();
      if (/s$/i.test(section)) alts.add(section.replace(/s$/i, ""));
      else alts.add(section + "s");
      for (const alt of alts) if (alt && alt !== section) sectionVariants.push(prefix + alt + rest);
    }
    candidates.push(...sectionVariants);

    if (tail.length >= 2) candidates.push(basePath(tail.slice(0, -1)));
    if (tail.length >= 3) candidates.push(basePath(tail.slice(0, -2)));

    const seen = new Set();
    return candidates.filter((p) => p && !seen.has(p) && seen.add(p));
  }

  /* ===========================================================================
   * 2. Compare configuration: per-table unique keys, identity candidates,
   *    volatile fields, friendly labels.
   * ========================================================================= */

  // Per-table primary keys (mirrors the SDK's unique_keys). Used to MATCH a
  // row across two snapshots. Keyed by normalized UI path.
  const UNIQUE_KEYS = {
    "/technology/routing/routes":      ["sn", "hostname", "network", "vrf", "nexthop"],
    "/technology/routing/routes/ipv6": ["sn", "hostname", "network", "vrf", "nexthop"],
    "/inventory/devices":              ["sn"],
    "/inventory/hosts":                ["ip", "mac", "sn", "intName"],
    "/inventory/hosts/ipv6":           ["ip", "mac", "sn", "intName"],
    "/technology/vlans/device-detail": ["sn", "vlanId"],
    "/technology/vlans/network-summary": ["vlanId"],
    "/technology/vlans/site-summary":  ["siteName", "vlanId"],
  };

  // Generic identity candidates (scalar, stable). Used when no preset matches.
  // Intentionally excludes object columns like `nexthop` (those are only keys
  // for tables that explicitly list them in UNIQUE_KEYS).
  const IDENTITY_CANDIDATES = [
    "sn", "snHw", "hostname", "deviceSn", "localSn", "siteName",
    "intName", "localInt", "nbrInt", "neighborInt",
    "nbrHostname", "neighborHostname", "remoteHostname",
    "network", "prefix", "vrf", "vlanId", "vlanName",
    "mac", "ip", "loginIp", "loginIpv4",
    "poolName", "poolMemberName", "memberIp", "name",
  ];

  // Fields that are inherently volatile (timers/counters). Excluded from a
  // generic identity key, and (optionally) ignored inside nested cells.
  const VOLATILE = new Set([
    "age", "uptime", "lastChange", "firstSeen", "lastSeen",
    "tsFirst", "tsLast", "bootTime", "upTime",
  ]);

  // Never offered as a comparable column (per-snapshot internal ids).
  const HIDDEN_COLUMNS = new Set(["id", "key", "_id", "niId", "siteKey"]);

  // Friendly labels for common IP Fabric columns. Anything not here is
  // prettified from camelCase.
  const COLUMN_LABELS = {
    sn: "Serial Number", snHw: "Serial (HW)", hostname: "Hostname",
    siteName: "Site", intName: "Interface", localInt: "Local Interface",
    nbrInt: "Neighbor Interface", neighborInt: "Neighbor Interface",
    nbrHostname: "Neighbor Hostname", neighborHostname: "Neighbor Hostname",
    network: "Network / Prefix", prefix: "Prefix", prefixLength: "Prefix Length",
    nexthop: "Next Hop", nhCount: "# Next Hops", protocol: "Protocol",
    vrf: "VRF", vlanId: "VLAN ID", vlanName: "VLAN Name", mac: "MAC",
    ip: "IP", loginIp: "Login IP", loginIpv4: "Login IPv4",
    vendor: "Vendor", family: "Family", model: "Model", platform: "Platform",
    version: "Version", dscr: "Description", description: "Description",
    devCount: "Device Count", stpDomain: "STP Domain", rootId: "Root ID",
    status: "Status", stdStatus: "Intent Status", poolName: "Pool Name",
    poolMemberName: "Pool Member", memberIp: "Member IP", availability: "Availability",
    state: "State", port: "Port", reload: "Last Reload", uptime: "Uptime",
  };

  const KNOWN_ACRONYMS = {
    ip: "IP", ipv4: "IPv4", ipv6: "IPv6", vrf: "VRF", vlan: "VLAN",
    sn: "SN", mac: "MAC", stp: "STP", id: "ID", os: "OS", url: "URL",
    uri: "URI", dns: "DNS", qos: "QoS", ad: "AD", lldp: "LLDP", cdp: "CDP",
    bgp: "BGP", ospf: "OSPF", mtu: "MTU", nat: "NAT", acl: "ACL",
  };

  function prettify(field) {
    if (COLUMN_LABELS[field]) return COLUMN_LABELS[field];
    // camelCase / snake_case → words
    const words = String(field)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
      .split(/\s+/);
    return words
      .map((w) => KNOWN_ACRONYMS[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
  }

  function normPath(p) {
    return String(p || "").toLowerCase().replace(/\/+$/, "") || "/";
  }

  /* ===========================================================================
   * 3. Value normalization & display
   * ========================================================================= */

  // Deterministic string form of any cell value for EQUALITY comparison.
  // Objects get sorted keys; arrays get sorted serialized elements (so the
  // order of e.g. ECMP next-hops doesn't create false diffs). `ignore` names
  // nested keys to drop (e.g. the volatile `age` inside a next-hop object).
  function stableStringify(v, ignore) {
    if (v === null || v === undefined) return "";
    const t = typeof v;
    if (t !== "object") return String(v);
    if (Array.isArray(v)) {
      const items = v.map((x) => stableStringify(x, ignore));
      items.sort();
      return "[" + items.join("|") + "]";
    }
    const keys = Object.keys(v).filter((k) => !ignore || !ignore.has(k)).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k], ignore)).join(",") + "}";
  }

  function normalizeValue(v, ignore) {
    return stableStringify(v, ignore);
  }

  // Human-readable rendering of a cell for the results table.
  function formatCellDisplay(v) {
    if (v === null || v === undefined || v === "") return "∅";
    const t = typeof v;
    if (t !== "object") return String(v);
    if (Array.isArray(v)) {
      // Next-hop array? Render compactly.
      if (v.length && v[0] && typeof v[0] === "object" && ("ip" in v[0] || "intName" in v[0])) {
        return v.map(formatNexthop).join(",  ");
      }
      if (!v.length) return "∅";
      return v.map((x) => formatCellDisplay(x)).join(",  ");
    }
    if ("ip" in v || "intName" in v) return formatNexthop(v);
    if ("data" in v && typeof v.data !== "object") return String(v.data);
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  function formatNexthop(nh) {
    if (!nh || typeof nh !== "object") return String(nh);
    const ip = nh.ip != null ? nh.ip : "";
    const via = nh.intName ? ` via ${nh.intName}` : "";
    const metric = [];
    if (nh.ad != null) metric.push("ad " + nh.ad);
    if (nh.metric != null) metric.push("m " + nh.metric);
    const m = metric.length ? ` [${metric.join("/")}]` : "";
    const core = (ip || via) ? `${ip}${via}${m}` : JSON.stringify(nh);
    return core;
  }

  /* ===========================================================================
   * 4. API client
   * ========================================================================= */

  function timeoutSignal(ms, parent) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    if (parent) {
      if (parent.aborted) ac.abort();
      else parent.addEventListener("abort", () => ac.abort(), { once: true });
    }
    return { signal: ac.signal, clear: () => clearTimeout(timer) };
  }

  // GET /api/snapshots → normalized list [{id,name,state,loaded,date,count}, ...]
  async function listSnapshots() {
    const { signal, clear } = timeoutSignal(FETCH_TIMEOUT_MS);
    try {
      const res = await fetch("/api/snapshots", {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json();
      const list = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
      const out = list.map(normalizeSnapshot).filter((s) => s.id);
      // newest first by date
      out.sort((a, b) => (b.sortTs || 0) - (a.sortTs || 0));
      return { ok: true, snapshots: out };
    } catch (err) {
      return { ok: false, status: 0, reason: err && err.message };
    } finally {
      clear();
    }
  }

  function normalizeSnapshot(s) {
    if (!s || typeof s !== "object") return {};
    const id = s.id || s.snapshotId || s.snapshot_id || "";
    const name = s.name || s.note || "";
    const state = s.state || s.status || "";
    const loaded = s.loaded === true || /loaded|done/i.test(state);
    const dateRaw = s.tsEnd ?? s.end ?? s.finishedAt ?? s.tsStart ?? s.start ?? s.startedAt ?? s.loadedAt ?? null;
    const sortTs = toTs(dateRaw);
    return {
      id, name, state, loaded,
      date: fmtDate(dateRaw),
      sortTs,
      count: s.totalDevCount ?? s.count ?? s.devices ?? null,
      locked: s.locked === true || /locked/i.test(state),
    };
  }

  function toTs(v) {
    if (v == null) return 0;
    if (typeof v === "number") return v > 1e12 ? v : v * 1000; // s or ms
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  function fmtDate(v) {
    const ts = toTs(v);
    if (!ts) return "";
    try { return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
    catch { return ""; }
  }

  // Determine the snapshot the table view is currently showing.
  function pickCurrentSnapshot(snapshots) {
    try {
      const p = new URLSearchParams(location.search).get("selectSnapshot");
      if (p) {
        if (/^[0-9a-f-]{36}$/i.test(p)) {
          const hit = snapshots.find((s) => s.id.toLowerCase() === p.toLowerCase());
          if (hit) return hit.id;
        }
        // $last / $prev / $lastLocked shortcuts
        if (p === "$last") { const l = loadedByRecency(snapshots)[0]; if (l) return l.id; }
        if (p === "$prev") { const l = loadedByRecency(snapshots)[1] || loadedByRecency(snapshots)[0]; if (l) return l.id; }
        if (p === "$lastLocked") { const l = loadedByRecency(snapshots).find((s) => s.locked); if (l) return l.id; }
      }
    } catch (_) {}
    const l = loadedByRecency(snapshots)[0];
    if (l) return l.id;
    return snapshots.length ? snapshots[0].id : null;
  }
  function loadedByRecency(snapshots) {
    return snapshots.filter((s) => s.loaded).sort((a, b) => (b.sortTs || 0) - (a.sortTs || 0));
  }

  // Parse a 422 column-validation body → indices of invalid columns.
  function invalidColumnIndices(errJson) {
    if (!errJson || !Array.isArray(errJson.errors)) return null;
    const bad = new Set();
    let saw = false;
    for (const e of errJson.errors) {
      const f = e && e.field;
      if (Array.isArray(f) && f[0] === "columns") {
        saw = true;
        if (typeof f[1] === "number") bad.add(f[1]);
      }
    }
    if (!saw || bad.size === 0) return null;
    return bad;
  }

  // Extract valid column names enumerated in a 422 message.
  function discoverColumnsFromError(errJson) {
    if (!errJson) return null;
    const names = new Set();
    const harvest = (text) => {
      if (typeof text !== "string") return;
      const m = text.match(/one of\s*\[([^\]]+)\]/i);
      if (m) for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^['"]|['"]$/g, "");
        if (name && /^[a-zA-Z0-9_]+$/.test(name)) names.add(name);
      }
    };
    if (Array.isArray(errJson.errors)) for (const e of errJson.errors) {
      harvest(e && e.message);
      if (Array.isArray(e && e.expected)) for (const c of e.expected) if (typeof c === "string") names.add(c);
    }
    harvest(errJson.message);
    return names.size ? Array.from(names) : null;
  }

  // Low-level single POST to one API path. Returns
  //   {ok:true, rows, meta, usedColumns} | {ok:false, status, reason, errJson}
  async function postTable(apiPath, uiPath, snapshotId, columns, limit, start, parentSignal) {
    const body = {
      snapshot: snapshotId,
      filters: {},
      pagination: { limit, start },
      reports: uiPath,
    };
    if (columns) body.columns = columns;

    const { signal, clear } = timeoutSignal(FETCH_TIMEOUT_MS, parentSignal);
    try {
      const res = await fetch(apiPath, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) {
        let json;
        try { json = await res.json(); } catch (e) { return { ok: false, status: 0, reason: "bad json" }; }
        const rows = Array.isArray(json?.data) ? json.data : [];
        const count = json?._meta?.count ?? json?.count ?? json?._meta?.size ?? null;
        return { ok: true, rows, meta: { count }, usedColumns: columns || null };
      }
      let errJson = null;
      if (res.status === 422) { try { errJson = await res.json(); } catch (_) {} }
      return { ok: false, status: res.status, errJson };
    } catch (err) {
      return { ok: false, status: 0, reason: (err && err.name === "AbortError") ? "timeout" : (err && err.message) };
    } finally {
      clear();
    }
  }

  // Discover the FULL comparable column set for a table, for the Diff Dashboard
  // "Column to compare" dropdown.
  //
  // The API's default (omit-columns) projection, and the curated per-table
  // lists in TABLE_COLUMN_OVERRIDES, are each only a SUBSET of a table's
  // columns. To offer every comparable column instead, this asks IP Fabric for
  // the table's complete allowed-column list using the server's own validation
  // enumeration: send a single deliberately-invalid column and the 422 response
  // lists '... must be one of [ <every column> ]'. That enumerated set is then
  // unioned with the columns that actually appear in returned rows (and, as a
  // safety net, the documented override list) to produce the complete set.
  //
  // This is used ONLY to populate the dropdown; the comparison itself still
  // requests just the identity + selected columns (see fetchAllRows), so the
  // compare engine, snapshot handling and Global Search are unaffected.
  async function fetchFirstPage(uiPath, snapshotId, parentSignal) {
    const candidates = uiPathToApi(uiPath);
    const COLUMN_PROBE = "__ipfsd_colprobe__"; // a column name no table defines
    let lastStatus = 0, lastReason = null;

    for (const apiPath of candidates) {
      // 1) Establish that this candidate path works; grab default rows if any.
      let rows = [], meta = null, haveRows = false, needColumns = false;
      const r0 = await postTable(apiPath, uiPath, snapshotId, null, 50, 0, parentSignal);
      if (r0.ok) { haveRows = true; rows = r0.rows; meta = r0.meta; }
      else if (r0.status === 401 || r0.status === 403) return { ok: false, status: r0.status, reason: "auth" };
      else if (r0.status === 422) { needColumns = true; }     // path exists, requires explicit columns
      else { lastStatus = r0.status; lastReason = r0.reason; continue; } // 404/timeout → next candidate

      // 2) Ask the server for the complete allowed-column list (enumeration).
      let enumerated = null;
      const probe = await postTable(apiPath, uiPath, snapshotId, [COLUMN_PROBE], 1, 0, parentSignal);
      if (!probe.ok && probe.status === 422) {
        const disc = discoverColumnsFromError(probe.errJson);
        if (disc && disc.length) enumerated = disc;
      }

      // 3) If the server required columns (no default rows), fetch rows using the
      //    enumerated set (or COMMON_COLUMNS), dropping any it rejects once.
      if (!haveRows) {
        let cols = (enumerated && enumerated.length) ? enumerated.slice() : COMMON_COLUMNS.slice();
        let rr = await postTable(apiPath, uiPath, snapshotId, cols, 50, 0, parentSignal);
        if (!rr.ok && rr.status === 422) {
          const bad = invalidColumnIndices(rr.errJson);
          if (bad && bad.size) {
            const filtered = cols.filter((_, i) => !bad.has(i));
            if (filtered.length) rr = await postTable(apiPath, uiPath, snapshotId, filtered, 50, 0, parentSignal);
          }
        }
        if (rr.ok) { haveRows = true; rows = rr.rows; meta = rr.meta; }
      }

      // 4) Union enumeration + actual row keys + documented overrides.
      const set = new Set();
      if (enumerated) for (const c of enumerated) set.add(c);
      for (const row of rows) if (row && typeof row === "object") for (const k of Object.keys(row)) set.add(k);
      const ov = TABLE_COLUMN_OVERRIDES[normPath(uiPath)];
      if (ov) for (const c of ov) set.add(c);

      if (set.size) {
        return { ok: true, apiPath, rows, meta,
                 columns: Array.from(set), columnsApproximate: !haveRows && !enumerated };
      }
      // Path worked but produced no columns (empty table + no enumeration):
      // fall back to COMMON_COLUMNS so the dropdown is never empty.
      if (haveRows || needColumns) {
        return { ok: true, apiPath, rows, meta,
                 columns: COMMON_COLUMNS.slice(), columnsApproximate: true };
      }
      lastStatus = r0.status; lastReason = r0.reason;
    }
    return { ok: false, status: lastStatus, reason: lastReason || "not found" };
  }

  /* ---- Authoritative column catalog from IP Fabric's OpenAPI spec -------- */
  //
  // IP Fabric serves its complete table/column catalog as an OpenAPI document at
  // /api/static/oas/openapi-internal.json — this is exactly what the IP Fabric
  // Python SDK's get_columns() reads. For each table's POST it lists the UI
  // columns (x-table.columns[].key, in UI order) and the full set of queryable
  // columns (requestBody…columns.items.enum). Reading this gives the Diff
  // Dashboard dropdown EVERY comparable column for a table — the complete,
  // version-matched set — instead of only the API's default (omit-columns)
  // projection. Fetched once per page session and cached; best-effort, with a
  // graceful fallback to the discovered columns if the OAS can't be read.
  let oasMap = null;   // normalized endpoint -> { columns, uiColumns, labels, webPath, title }
  let oasTried = false;

  function normOasKey(p) {
    return String(p || "")
      .replace(/^https?:\/\/[^/]+/i, "")
      .replace(/^\/+/, "")
      .replace(/^api\//, "")
      .replace(/^v\d+\//, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  function parseOas(oas) {
    const map = {};
    const paths = oas && oas.paths;
    if (!paths || typeof paths !== "object") return map;
    for (const rawPath of Object.keys(paths)) {
      const methods = paths[rawPath];
      const post = methods && methods.post;
      if (!post) continue;
      const xt = post["x-table"];
      const uiCols = [], labels = {};
      if (xt && Array.isArray(xt.columns)) {
        for (const c of xt.columns) {
          if (!c || !c.key) continue;
          uiCols.push(c.key);
          const lbl = c.label || c.title || c.name || c.header || c.headerName || c.displayName;
          if (lbl && typeof lbl === "string") labels[c.key] = lbl;
        }
      }
      let enumCols = [];
      try { enumCols = post.requestBody.content["application/json"].schema.properties.columns.items.enum || []; }
      catch (_) { enumCols = []; }
      const all = [], seen = new Set();
      for (const c of uiCols) if (c && !seen.has(c)) { seen.add(c); all.push(c); }
      for (const c of enumCols) if (c && !seen.has(c)) { seen.add(c); all.push(c); }
      if (!all.length) continue; // not a data table
      map[normOasKey(rawPath)] = {
        columns: all, uiColumns: uiCols, labels,
        webPath: (xt && xt.webPath) || null, title: (xt && xt.title) || null,
      };
    }
    return map;
  }

  async function ensureOas(parentSignal) {
    if (oasMap || oasTried) return oasMap;
    oasTried = true;
    const { signal, clear } = timeoutSignal(FETCH_TIMEOUT_MS, parentSignal);
    try {
      const res = await fetch("/api/static/oas/openapi-internal.json", {
        method: "GET", credentials: "include", headers: { Accept: "application/json" }, signal,
      });
      if (!res.ok) return null;
      const json = await res.json();
      const parsed = parseOas(json);
      oasMap = Object.keys(parsed).length ? parsed : null;
      return oasMap;
    } catch (_) {
      return null; // best-effort; caller falls back to discovered columns
    } finally { clear(); }
  }

  function oasColumnsFor(apiPath) {
    if (!oasMap) return null;
    return oasMap[normOasKey(apiPath)] || null;
  }

  // Best-effort: read column display labels from the rendered table headers so
  // the dropdown labels match what the user sees (e.g. the `network` field is
  // shown as "Route" on the routes table). Maps field (col-id / data-field) to
  // its header text. Returns {} if the grid structure isn't recognized.
  function scrapeHeaderLabels() {
    const labels = {};
    try {
      const heads = document.querySelectorAll('[role="columnheader"], thead th[col-id], thead th[data-field]');
      heads.forEach((hd) => {
        if ((hostEl && hostEl.contains(hd)) || (launcherEl && launcherEl.contains(hd))) return;
        const field = hd.getAttribute("col-id") || hd.getAttribute("data-field") ||
                      hd.getAttribute("data-colid") || hd.getAttribute("data-column-id") || hd.getAttribute("data-key");
        if (!field || !/^[A-Za-z_][\w.]*$/.test(field) || labels[field]) return;
        const t = hd.querySelector(".ag-header-cell-text");
        let txt = ((t ? t.textContent : hd.textContent) || "").replace(/\s+/g, " ").trim();
        if (txt && txt.length <= 60) labels[field] = txt;
      });
    } catch (_) {}
    return labels;
  }

  function labelFor(field) {
    return (state.colLabels && state.colLabels[field]) || prettify(field);
  }

  // Fetch ALL rows for a table/snapshot, requesting only the given columns,
  // paginating until exhausted. Drops any columns a given snapshot rejects
  // (older schema) once. Returns {ok, rows, droppedColumns}.
  async function fetchAllRows(apiPath, uiPath, snapshotId, columns, parentSignal, onProgress) {
    let cols = columns ? columns.slice() : null;
    const rows = [];
    let start = 0;
    let dropped = [];
    for (let guard = 0; guard < 1000; guard++) {
      const r = await postTable(apiPath, uiPath, snapshotId, cols, PAGE_LIMIT, start, parentSignal);
      if (!r.ok) {
        if (r.status === 422 && cols) {
          const bad = invalidColumnIndices(r.errJson);
          if (bad && bad.size) {
            const kept = [], drop = [];
            cols.forEach((c, i) => (bad.has(i) ? drop.push(c) : kept.push(c)));
            if (kept.length && kept.length < cols.length) {
              dropped = dropped.concat(drop);
              cols = kept; start = 0; rows.length = 0; continue;
            }
          }
        }
        return { ok: false, status: r.status, reason: r.reason, droppedColumns: dropped };
      }
      rows.push(...r.rows);
      if (onProgress) onProgress(rows.length);
      if (r.rows.length < PAGE_LIMIT) break;
      start += PAGE_LIMIT;
      if (start >= ROW_CAP) break;
    }
    return { ok: true, rows, droppedColumns: dropped };
  }

  /* ===========================================================================
   * 5. Compare engine
   * ========================================================================= */

  function resolveIdentityCols(uiPath, availableCols, selectedCol) {
    const avail = new Set(availableCols);
    let keys = UNIQUE_KEYS[normPath(uiPath)];
    if (keys) keys = keys.filter((c) => avail.has(c));
    else keys = IDENTITY_CANDIDATES.filter((c) => avail.has(c));
    keys = keys.filter((c) => c !== selectedCol);
    if (!keys.length) {
      keys = availableCols.filter((c) => c !== selectedCol && !VOLATILE.has(c) && !HIDDEN_COLUMNS.has(c));
    }
    return keys;
  }

  // Build the per-row identity string from the identity columns.
  // `ignore` (the volatile-field set) is applied here too: when a nested
  // column such as `nexthop` is part of the primary key, its volatile `age`
  // timer must be ignored, or otherwise-identical rows would match by nothing
  // and show up as only-in-A + only-in-B on every snapshot. This mirrors the
  // SDK's `nested_columns_ignore` being honoured inside the unique_keys too.
  function identityKey(row, identityCols, ignore) {
    return identityCols.map((c) => normalizeValue(row[c], ignore)).join("\u0001");
  }
  function identityDisplay(row, identityCols) {
    return identityCols.map((c) => `${labelFor(c)}: ${formatCellDisplay(row[c])}`).join("  ·  ");
  }

  // Group rows by identity, collecting the selected column's values.
  function groupRows(rows, identityCols, selectedCol, ignore) {
    const m = new Map();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const key = identityKey(row, identityCols, ignore);
      let g = m.get(key);
      if (!g) { g = { key, display: identityDisplay(row, identityCols), values: [] }; m.set(key, g); }
      g.values.push({
        norm: normalizeValue(row[selectedCol], ignore),
        disp: formatCellDisplay(row[selectedCol]),
        row,
      });
    }
    return m;
  }

  function valuesSignature(values) {
    return values.map((v) => v.norm).sort().join("\u0002");
  }

  // Core diff. A = current snapshot rows, B = other snapshot rows.
  //   onlyInA  : identity present now, absent in the compared snapshot (added)
  //   onlyInB  : identity present in compared snapshot, absent now (removed)
  //   changed  : identity in both, selected-column value(s) differ
  function computeDiff(rowsA, rowsB, identityCols, selectedCol, ignoreVolatile) {
    const ignore = ignoreVolatile ? VOLATILE : null;
    const A = groupRows(rowsA, identityCols, selectedCol, ignore);
    const B = groupRows(rowsB, identityCols, selectedCol, ignore);

    const onlyInA = [], onlyInB = [], changed = [];
    let unchanged = 0;

    for (const [key, a] of A) {
      const b = B.get(key);
      if (!b) { onlyInA.push({ key, display: a.display, values: a.values }); continue; }
      if (valuesSignature(a.values) === valuesSignature(b.values)) { unchanged++; continue; }
      changed.push({ key, display: a.display, aValues: a.values, bValues: b.values });
    }
    for (const [key, b] of B) {
      if (!A.has(key)) onlyInB.push({ key, display: b.display, values: b.values });
    }

    return {
      onlyInA, onlyInB, changed, unchanged,
      totalA: rowsA.length, totalB: rowsB.length,
      keysA: A.size, keysB: B.size,
    };
  }

  /* ===========================================================================
   * 6. Deep links back into the IP Fabric UI
   * ========================================================================= */

  function buildDeepLink(uiPath, identityCols, row, snapshotId) {
    try {
      const clauses = [];
      for (const c of identityCols) {
        const v = row[c];
        if (v == null) continue;
        if (typeof v === "object") continue; // can't filter on nested cells
        clauses.push({ [c]: ["eq", typeof v === "number" ? v : String(v)] });
      }
      if (!clauses.length) return null;
      const opts = encodeURIComponent(JSON.stringify({ filters: { and: clauses } }));
      let url = `${location.origin}${uiPath}?options=${opts}`;
      if (snapshotId) url += `&selectSnapshot=${encodeURIComponent(snapshotId)}`;
      return url;
    } catch (_) { return null; }
  }

  /* ===========================================================================
   * 7. Table detection
   * ========================================================================= */

  function detectTable() {
    const path = normPath(location.pathname);
    const isTable = /^\/(technology|inventory)\//.test(path);
    return { path, isTable };
  }

  /* ===========================================================================
   * 8. UI — Shadow DOM panel
   * ========================================================================= */

  const HOST_ID = "ipf-snapshot-diff-host";
  let hostEl = null, root = null, els = {}, launcherEl = null, launcherBtn = null;
  let pendingShow = false; // set when a toggle requests the panel be shown as it boots
  let state = {
    snapshots: [], currentId: null, uiPath: null, apiPath: null,
    availableCols: [], busy: false, lastResult: null, lastMeta: null,
    collapsed: false, hidden: true, ignoreVolatile: true,
    loadedPath: null, userPlaced: false, loading: false,
    featureVisible: true, // Options → "Show Diff Dashboard" (default on)
    colLabels: {},        // field -> display label (from OAS / rendered headers)
    matchKeys: [],        // the columns rows are matched on (the primary key)
    matchKeysAuto: true,  // true while matchKeys is the auto-derived default
  };

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .wrap {
      position: fixed; z-index: 2147483000;
      font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px; color: #24292e;
      background: #ffffff; border: 1px solid #d0d7de;
      border-radius: 8px; box-shadow: 0 8px 28px rgba(8,19,42,0.22);
      display: flex; flex-direction: column; overflow: hidden;
      min-width: 320px; min-height: 120px;
    }
    .wrap.collapsed { min-height: 0 !important; height: auto !important; }
    .wrap.collapsed .body, .wrap.collapsed .resize { display: none !important; }

    .hdr {
      display: flex; align-items: center; gap: 8px;
      background: ${BRAND.bar}; color: #fff;
      padding: 0 10px; height: 38px; cursor: move; user-select: none;
      flex-shrink: 0;
    }
    .hdr .logo { width: 18px; height: 18px; flex-shrink: 0; border-radius: 3px; }
    .hdr .title { font-weight: 700; font-size: 13px; letter-spacing: .01em; white-space: nowrap; }
    .hdr .sub { font-weight: 400; font-size: 11px; color: ${BRAND.gray === '#8d999b' ? '#c6d0e4' : '#c6d0e4'}; margin-left: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hdr .spacer { flex: 1 1 auto; }
    .hdr button {
      all: unset; cursor: pointer; width: 26px; height: 26px; border-radius: 5px;
      display: inline-flex; align-items: center; justify-content: center;
      color: rgba(255,255,255,.82);
    }
    .hdr button:hover { background: rgba(255,255,255,.14); color: #fff; }
    .hdr button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }

    .body { padding: 12px; overflow: auto; flex: 1 1 auto; }

    .controls { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end; }
    .field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .field label { font-size: 11px; font-weight: 600; color: #57606a; text-transform: uppercase; letter-spacing: .03em; }
    .field select, .field input {
      font-family: inherit; font-size: 13px; color: #24292e;
      background: #fff; border: 1px solid #d0d7de; border-radius: 5px;
      height: 30px; padding: 0 8px; max-width: 320px;
    }
    .field select:focus, .field input:focus { outline: none; border-color: ${BRAND.bar}; box-shadow: 0 0 0 2px rgba(37,64,131,.18); }
    .field.grow { flex: 1 1 200px; }
    .field.grow select { width: 100%; max-width: none; }

    .actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    .btn {
      all: unset; cursor: pointer; box-sizing: border-box;
      height: 32px; padding: 0 16px; border-radius: 6px; font-weight: 700; font-size: 13px;
      display: inline-flex; align-items: center; gap: 7px; justify-content: center;
      background: ${BRAND.bar}; color: #fff; border: 1px solid ${BRAND.bar};
    }
    .btn:hover { background: ${BRAND.barDeep}; }
    .btn:disabled { opacity: .55; cursor: progress; }
    .btn.secondary { background: #fff; color: ${BRAND.bar}; border-color: #d0d7de; font-weight: 600; }
    .btn.secondary:hover { background: #f1f2f4; }
    .btn:focus-visible { outline: 2px solid ${BRAND.bar}; outline-offset: 2px; }

    .swap { all: unset; cursor: pointer; color: ${BRAND.bar}; font-size: 16px; padding: 0 4px; align-self: flex-end; height: 30px; display:inline-flex; align-items:center; }
    .swap:hover { color: ${BRAND.magenta}; }

    .check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #57606a; cursor: pointer; }
    .check input { width: 14px; height: 14px; accent-color: ${BRAND.bar}; }

    .note { font-size: 12px; color: #6e7781; margin-top: 8px; line-height: 1.5; }
    .note code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #f6f8fa; padding: 1px 4px; border-radius: 3px; }
    .err { color: ${BRAND.removed}; background: ${BRAND.removedBg}; border: 1px solid #ffc1bc; border-radius: 6px; padding: 8px 10px; margin-top: 10px; font-size: 12px; }

    .summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 4px; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700;
      padding: 4px 10px; border-radius: 999px; border: 1px solid transparent;
    }
    .chip b { font-weight: 800; }
    .chip.added   { background: ${BRAND.addedBg};   color: ${BRAND.added};   border-color: #ace0bb; }
    .chip.removed { background: ${BRAND.removedBg}; color: ${BRAND.removed}; border-color: #ffc1bc; }
    .chip.changed { background: ${BRAND.changedBg}; color: ${BRAND.changed}; border-color: #ecd98a; }
    .chip.same    { background: #eef1f4; color: #57606a; border-color: #dde1e6; }

    .matchwrap { margin: 6px 0 2px; }
    .matchline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .matchkey { font-size: 11px; color: #6e7781; }
    .matchkey b { color: #424a53; }
    .autobadge { font-size: 10px; color: #8d99a6; font-style: italic; }
    .editkeys { all: unset; cursor: pointer; font-size: 11px; color: ${BRAND.bar}; border: 1px solid #d0d7de; border-radius: 5px; padding: 1px 8px; }
    .editkeys:hover { background: #f1f2f4; }
    .editkeys:disabled { opacity: .5; cursor: default; }
    .editkeys:focus-visible { outline: 2px solid ${BRAND.bar}; outline-offset: 1px; }
    .keyeditor { margin-top: 6px; border: 1px solid #e1e4e8; border-radius: 6px; padding: 8px; background: #fcfcfd; }
    .keyeditor[hidden] { display: none; }
    .keyeditor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .keyeditor-head > span { font-size: 11px; font-weight: 700; color: #57606a; text-transform: uppercase; letter-spacing: .03em; }
    .keys-auto { all: unset; cursor: pointer; font-size: 11px; color: ${BRAND.bar}; }
    .keys-auto:hover { text-decoration: underline; color: ${BRAND.magenta}; }
    .keylist { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 2px 12px; max-height: 180px; overflow: auto; }
    .keyopt { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #24292e; cursor: pointer; }
    .keyopt input { width: 13px; height: 13px; accent-color: ${BRAND.bar}; flex-shrink: 0; }
    .keyopt span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .keywarn { font-size: 11px; color: ${BRAND.changed}; margin-top: 6px; }

    .results { margin-top: 10px; }
    details.grp { border: 1px solid #e1e4e8; border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
    details.grp > summary {
      cursor: pointer; list-style: none; padding: 7px 10px; font-weight: 700; font-size: 12px;
      display: flex; align-items: center; gap: 8px; background: #f6f8fa;
    }
    details.grp > summary::-webkit-details-marker { display: none; }
    details.grp > summary .dot { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }
    details.grp.added   > summary { color: ${BRAND.added}; }
    details.grp.removed > summary { color: ${BRAND.removed}; }
    details.grp.changed > summary { color: ${BRAND.changed}; }
    details.grp .count { margin-left: auto; font-weight: 800; }

    table.res { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.res th, table.res td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
    table.res th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #6e7781; background: #fcfcfd; position: sticky; top: 0; }
    table.res td.id { color: #424a53; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; max-width: 520px; }
    table.res td.val { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
    table.res td.old { color: ${BRAND.removed}; }
    table.res td.new { color: ${BRAND.added}; }
    table.res a.link { color: ${BRAND.bar}; text-decoration: none; }
    table.res a.link:hover { text-decoration: underline; color: ${BRAND.magenta}; }
    .arrow { color: #8d999b; padding: 0 4px; }
    .tablewrap { max-height: 320px; overflow: auto; border-top: 1px solid #eef0f2; }

    .spin { width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.4); border-top-color:#fff; border-radius: 50%; animation: spin .7s linear infinite; }
    .btn.secondary .spin { border: 2px solid rgba(37,64,131,.3); border-top-color:${BRAND.bar}; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .progress { margin-top: 10px; font-size: 12px; color: #57606a; }

    .resize { position: absolute; width: 16px; height: 16px; right: 2px; bottom: 2px; cursor: nwse-resize; z-index: 2; }
    .resize::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px; border-right: 2px solid #b4bcc4; border-bottom: 2px solid #b4bcc4; }

    .empty { color: #6e7781; font-size: 12px; padding: 6px 0; }
  `;

  const LOGO_SVG = `data:image/svg+xml;utf8,` + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#fff"/><path d="M5 7h5v3H5zM5 11h5v6H5zM11 7h8v2h-8zM11 11h8v2h-8zM11 15h8v2h-8z" fill="#254083"/></svg>`
  );

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  function buildUI() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    hostEl.style.cssText = "all: initial;";
    root = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = h("div", { class: "wrap", role: "dialog", "aria-label": "IP Fabric Diff Dashboard" });

    // Header
    const hdr = h("div", { class: "hdr" },
      h("img", { class: "logo", src: LOGO_SVG, alt: "" }),
      h("span", { class: "title" }, "Diff Dashboard"),
      h("span", { class: "sub" }, ""),
      h("div", { class: "spacer" }),
      h("button", { class: "collapse", title: "Collapse / expand", "aria-label": "Collapse or expand" },
        iconSvg("chevron")),
      h("button", { class: "fit", title: "Fit to available space", "aria-label": "Fit to space" },
        iconSvg("fit")),
      h("button", { class: "gear", title: "Options", "aria-label": "Options" }, iconSvg("gear")),
      h("button", { class: "close", title: "Hide panel (reopen via the Diff Dashboard button on the header row, or Ctrl+Shift+D)", "aria-label": "Hide" },
        iconSvg("x")),
    );
    wrap.appendChild(hdr);

    // Body
    const body = h("div", { class: "body" });

    const controls = h("div", { class: "controls" },
      h("div", { class: "field grow" },
        h("label", {}, "Column to compare"),
        h("select", { class: "col", disabled: "true" })),
      h("div", { class: "field grow" },
        h("label", {}, "Snapshot A — current"),
        h("select", { class: "snapA", disabled: "true" })),
      h("button", { class: "swap", title: "Swap A and B", "aria-label": "Swap snapshots" }, "⇄"),
      h("div", { class: "field grow" },
        h("label", {}, "Snapshot B — compare with"),
        h("select", { class: "snapB", disabled: "true" })),
    );
    body.appendChild(controls);

    const actions = h("div", { class: "actions" },
      h("button", { class: "btn run", disabled: "true" }, "Compare"),
      h("button", { class: "btn secondary csv", disabled: "true" }, iconSvg("download"), "Export CSV"),
      h("label", { class: "check" },
        h("input", { type: "checkbox", class: "ignorevol" }),
        "Ignore volatile fields (age, uptime)"),
    );
    body.appendChild(actions);

    const matchWrap = h("div", { class: "matchwrap" },
      h("div", { class: "matchline" },
        h("span", { class: "matchkey" }),
        h("button", { class: "editkeys", type: "button", title: "Choose which columns rows are matched on", disabled: "true" }, "Edit match key")),
      h("div", { class: "keyeditor", hidden: "true" },
        h("div", { class: "keyeditor-head" },
          h("span", {}, "Match rows on (primary key)"),
          h("button", { class: "keys-auto", type: "button" }, "Reset to auto")),
        h("div", { class: "keylist" }),
        h("div", { class: "keywarn" })));
    body.appendChild(matchWrap);

    const msg = h("div", { class: "msgarea" });
    body.appendChild(msg);

    const summary = h("div", { class: "summary", style: "display:none" });
    body.appendChild(summary);

    const results = h("div", { class: "results" });
    body.appendChild(results);

    wrap.appendChild(body);

    const resize = h("div", { class: "resize", title: "Resize" });
    wrap.appendChild(resize);

    root.appendChild(wrap);
    // Hidden until restoreGeometry decides (default: hidden on first load).
    // Prevents any flash of the panel before the stored state is read.
    hostEl.style.display = "none";
    (document.body || document.documentElement).appendChild(hostEl);

    els = {
      wrap, hdr, body, msg, summary, results,
      matchkey: matchWrap.querySelector(".matchkey"),
      keyEditBtn: matchWrap.querySelector(".editkeys"),
      keyEditor: matchWrap.querySelector(".keyeditor"),
      keyList: matchWrap.querySelector(".keylist"),
      keyAuto: matchWrap.querySelector(".keys-auto"),
      keyWarn: matchWrap.querySelector(".keywarn"),
      sub: hdr.querySelector(".sub"),
      col: controls.querySelector(".col"),
      snapA: controls.querySelector(".snapA"),
      snapB: controls.querySelector(".snapB"),
      swap: controls.querySelector(".swap"),
      run: actions.querySelector(".run"),
      csv: actions.querySelector(".csv"),
      ignorevol: actions.querySelector(".ignorevol"),
      collapseBtn: hdr.querySelector(".collapse"),
      fitBtn: hdr.querySelector(".fit"),
      gearBtn: hdr.querySelector(".gear"),
      closeBtn: hdr.querySelector(".close"),
      resize,
    };

    wireEvents();
    restoreGeometry();
  }

  function iconSvg(name) {
    const svgs = {
      chevron: '<path d="M6 9l6 6 6-6"/>',
      x: '<path d="M18 6L6 18M6 6l12 12"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H8a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V8a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
      fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
      download: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/>',
    };
    const s = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgs[name] || ""}</svg>`;
    const span = document.createElement("span");
    span.style.cssText = "display:inline-flex;align-items:center;";
    span.innerHTML = s;
    return span;
  }

  /* ---- Event wiring ---------------------------------------------------- */

  function wireEvents() {
    els.closeBtn.addEventListener("click", () => hidePanel());
    els.gearBtn.addEventListener("click", () => {
      try { chrome.runtime.sendMessage({ type: "IPFSD_OPEN_OPTIONS" }).catch(() => {}); } catch (_) {}
    });
    els.collapseBtn.addEventListener("click", () => setCollapsed(!state.collapsed));
    els.fitBtn.addEventListener("click", () => { state.userPlaced = false; dockToAvailableSpace(true); });
    els.swap.addEventListener("click", swapSnapshots);
    els.run.addEventListener("click", runCompare);
    els.csv.addEventListener("click", exportCsv);
    // Wired once here (the <select> elements persist across SPA route changes;
    // only their <option>s are repopulated) to avoid stacking listeners.
    els.col.addEventListener("change", () => { recomputeAutoKeys(); rebuildKeyEditor(); updateMatchKeyHint(); refreshRunEnabled(); });
    els.snapA.addEventListener("change", refreshRunEnabled);
    els.snapB.addEventListener("change", refreshRunEnabled);
    els.keyEditBtn.addEventListener("click", () => {
      if (els.keyEditBtn.disabled) return;
      els.keyEditor.hidden = !els.keyEditor.hidden;
    });
    els.keyAuto.addEventListener("click", () => { recomputeAutoKeys(); rebuildKeyEditor(); updateMatchKeyHint(); });
    els.ignorevol.addEventListener("change", () => {
      state.ignoreVolatile = els.ignorevol.checked;
      try { chrome.storage.sync.set({ [STORE.ignoreVol]: state.ignoreVolatile }); } catch (_) {}
    });
    makeDraggable(els.hdr);
    makeResizable(els.resize);
  }

  function swapSnapshots() {
    const a = els.snapA.value, b = els.snapB.value;
    if (b) els.snapA.value = b;
    if (a) els.snapB.value = a;
  }

  /* ---- Match key (primary key the rows are compared on) ----------------- */

  // The effective match key for the current compare column: the user's chosen
  // columns, minus the compare column, intersected with what the table has.
  function effectiveMatchKeys(col) {
    return (state.matchKeys || []).filter((c) => c !== col && state.availableCols.includes(c));
  }

  // Reset the match key to the auto-derived default for the current column.
  function recomputeAutoKeys() {
    const col = els.col.value;
    state.matchKeys = col ? resolveIdentityCols(state.uiPath, state.availableCols, col) : [];
    state.matchKeysAuto = true;
  }

  // (Re)build the checkbox list of columns the rows can be matched on.
  function rebuildKeyEditor() {
    if (!els.keyList) return;
    els.keyList.innerHTML = "";
    const col = els.col.value;
    if (!col || !state.availableCols.length) {
      els.keyEditBtn.disabled = true;
      els.keyEditor.hidden = true;
      updateKeyWarn();
      return;
    }
    els.keyEditBtn.disabled = false;
    const chosen = new Set(state.matchKeys || []);
    for (const c of state.availableCols) {
      if (c === col || HIDDEN_COLUMNS.has(c)) continue;
      const cb = h("input", { type: "checkbox", value: c });
      cb.checked = chosen.has(c);
      cb.addEventListener("change", onKeyToggle);
      els.keyList.appendChild(h("label", { class: "keyopt", title: c }, cb, h("span", {}, labelFor(c) + " (" + c + ")")));
    }
    updateKeyWarn();
  }

  function onKeyToggle() {
    // Collect checked columns in availableCols order (matches DOM order).
    const checked = new Set();
    els.keyList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { if (cb.checked) checked.add(cb.value); });
    state.matchKeys = state.availableCols.filter((c) => checked.has(c));
    state.matchKeysAuto = false;
    updateMatchKeyHint();
    updateKeyWarn();
    refreshRunEnabled();
  }

  function updateKeyWarn() {
    if (!els.keyWarn) return;
    const col = els.col.value;
    const n = col ? effectiveMatchKeys(col).length : 0;
    els.keyWarn.textContent = (col && n === 0)
      ? "No key selected — the column's values are compared across all rows (no per-row matching)."
      : "";
  }

  function updateMatchKeyHint() {
    const col = els.col.value;
    if (!col || !state.availableCols.length) { els.matchkey.textContent = ""; return; }
    const keys = effectiveMatchKeys(col);
    els.matchkey.innerHTML = "";
    els.matchkey.append("Rows matched on: ");
    els.matchkey.appendChild(h("b", {}, keys.length ? keys.map(labelFor).join(", ") : "(all rows — no per-row key)"));
    if (state.matchKeysAuto) els.matchkey.appendChild(h("span", { class: "autobadge" }, " · auto"));
  }

  /* ---- Drag / resize / collapse / hide --------------------------------- */

  function makeDraggable(handle) {
    let sx, sy, sl, st, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const r = els.wrap.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      els.wrap.style.right = "auto";
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      e.preventDefault();
    });
    function onMove(e) {
      if (!dragging) return;
      let nl = sl + (e.clientX - sx), nt = st + (e.clientY - sy);
      nl = Math.max(2, Math.min(window.innerWidth - 80, nl));
      nt = Math.max(2, Math.min(window.innerHeight - 40, nt));
      els.wrap.style.left = nl + "px";
      els.wrap.style.top = nt + "px";
    }
    function onUp() {
      dragging = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      state.userPlaced = true;
      persistGeometry();
    }
  }

  function makeResizable(grip) {
    let sx, sy, sw, sh, resizing = false;
    grip.addEventListener("mousedown", (e) => {
      resizing = true;
      const r = els.wrap.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      e.preventDefault(); e.stopPropagation();
    });
    function onMove(e) {
      if (!resizing) return;
      const nw = Math.max(320, Math.min(window.innerWidth - 20, sw + (e.clientX - sx)));
      const nh = Math.max(160, Math.min(window.innerHeight - 20, sh + (e.clientY - sy)));
      els.wrap.style.width = nw + "px";
      els.wrap.style.height = nh + "px";
    }
    function onUp() {
      resizing = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      state.userPlaced = true;
      persistGeometry();
    }
  }

  function setCollapsed(v) {
    state.collapsed = v;
    els.wrap.classList.toggle("collapsed", v);
    els.collapseBtn.style.transform = v ? "rotate(-90deg)" : "";
    try { chrome.storage.sync.set({ [STORE.collapsed]: v }); } catch (_) {}
  }

  function setHidden(v, persist = true) {
    state.hidden = v;
    if (hostEl) hostEl.style.display = v ? "none" : "block";
    if (launcherBtn) launcherBtn.classList.toggle("active", !v);
    if (persist) { try { chrome.storage.sync.set({ [STORE.hidden]: v }); } catch (_) {} }
  }

  // Show the panel: make it visible, re-fit to the current table layout unless
  // the user has manually placed it, and lazily load snapshots/columns.
  function showPanel() {
    setHidden(false, true);
    if (!state.userPlaced) dockToAvailableSpace(false);
    ensureLoaded();
  }
  function hidePanel() { setHidden(true, true); }
  function togglePanel() {
    if (!state.featureVisible) return; // feature disabled in Options
    if (state.hidden) showPanel(); else hidePanel();
  }

  // Show or hide the ENTIRE Diff Dashboard feature (its header-row launcher and
  // panel), driven by the Options → Display "Show Diff Dashboard" setting —
  // the same show/hide pattern the companion extension uses for Global Search,
  // the LLM session, and CVE Security Status. Turning the feature off hides the
  // launcher and closes the panel (without disturbing the user's own open/closed
  // preference); turning it back on restores the launcher.
  function applyFeatureVisibility(show) {
    state.featureVisible = !!show;
    if (launcherEl) launcherEl.style.display = show ? "" : "none";
    if (show) {
      positionLauncher();
    } else {
      setHidden(true, false); // close the panel; don't overwrite snapdiff_hidden
    }
  }

  // Load table data the first time the panel is shown for a given route (and
  // after a route change while visible). Avoids any API calls while hidden.
  function ensureLoaded() {
    if (state.loading) return;
    const p = detectTable().path;
    if (state.loadedPath !== p) loadSnapshotsAndColumns();
  }

  /* ---- Host-page launcher (toggle icon on the IP Fabric header row) ------ */
  //
  // A compact, brand-styled button overlaid on the IP Fabric top header row —
  // the same host-page overlay technique the companion Global Search / CVE
  // extension uses for its header controls. It is always visible (even while
  // the Diff panel is hidden, which is the default on first load) and toggles
  // the panel. It lives in its own Shadow DOM host so it is unaffected when the
  // panel host is display:none, and so host-page CSS can't touch it.
  const COMPARE_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="5" width="7" height="14" rx="1.3"></rect>' +
    '<rect x="14" y="5" width="7" height="14" rx="1.3"></rect>' +
    '<path d="M12 8.5v7"></path></svg>';

  const LAUNCHER_CSS = `
    :host { all: initial; }
    .launch {
      all: unset; box-sizing: border-box;
      position: fixed; top: 9px; left: 50%; transform: translateX(-50%);
      z-index: 2147483600; cursor: pointer;
      display: inline-flex; align-items: center; gap: 7px;
      height: 30px; padding: 0 14px; border-radius: 6px;
      font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px; font-weight: 700; letter-spacing: .01em; white-space: nowrap;
      color: #ffffff; background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.48);
      box-shadow: 0 1px 2px rgba(8,19,42,0.18);
      transition: background .12s ease, border-color .12s ease, color .12s ease;
    }
    .launch:hover { background: rgba(255,255,255,0.22); border-color: rgba(255,255,255,0.85); }
    .launch:active { background: rgba(255,255,255,0.10); }
    .launch:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
    .launch.active { background: #ffffff; color: ${BRAND.bar}; border-color: #ffffff; }
    .launch .ico { display: inline-flex; align-items: center; }
    .launch .ico svg { display: block; }
    .launch .lbl { line-height: 1; }
  `;

  function buildLauncher() {
    if (launcherEl) return;
    launcherEl = document.createElement("div");
    launcherEl.id = "ipf-snapdiff-launcher-host";
    launcherEl.style.cssText = "all: initial;";
    const lr = launcherEl.attachShadow({ mode: "open" });
    const st = document.createElement("style");
    st.textContent = LAUNCHER_CSS;
    lr.appendChild(st);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "launch";
    btn.title = "Show / hide IP Fabric Diff Dashboard  (Ctrl+Shift+D)";
    btn.setAttribute("aria-label", "Toggle IP Fabric Diff Dashboard panel");
    btn.innerHTML = '<span class="ico">' + COMPARE_ICON_SVG + '</span><span class="lbl">Diff Dashboard</span>';
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
    lr.appendChild(btn);
    (document.body || document.documentElement).appendChild(launcherEl);
    launcherBtn = btn;
    launcherBtn.classList.toggle("active", !state.hidden);

    // Place it now, and keep it clear of the companion "Global Search + LLM
    // Interactive + CVE" extension's bar/control if that extension is (or
    // later becomes) loaded in the same tab.
    positionLauncher();
    window.addEventListener("resize", positionLauncher);
    try {
      const mo = new MutationObserver(() => {
        clearTimeout(positionLauncher._t);
        positionLauncher._t = setTimeout(positionLauncher, 120);
      });
      // The companion extension appends its iframe/CVE control as direct
      // children of <html> and its page-push <style> into <head>, so watching
      // those two childLists catches it appearing, disappearing, or toggling.
      mo.observe(document.documentElement, { childList: true });
      if (document.head) mo.observe(document.head, { childList: true });
    } catch (_) {}
    // A few delayed re-checks cover the companion loading slightly after us
    // (it mounts its controls asynchronously after reading its own storage).
    [300, 1000, 2500].forEach((d) => setTimeout(positionLauncher, d));
  }

  /* ---- Coexistence with the Global Search + LLM + CVE extension ---------- */
  //
  // That extension injects a full-width fixed bar (Global Search on the left,
  // LLM Interactive Session on the right) at the very top, pushes the IP Fabric
  // header down by its bar height, and overlays a horizontally-centered "CVE
  // Security Status" control on the (now shifted) header row. We detect it by
  // the stable DOM ids it uses and place our launcher where it can't overlap
  // any of those: below the bar, and offset from the centered CVE control.
  const GS_BAR_H = 48; // the companion bar's resting height / page-push amount

  function gsBarPresent() {
    return !!(document.getElementById("ipf-global-search-iframe") ||
              document.getElementById("ipf-gs-host-style"));
  }
  function gsCveControl() {
    const el = document.getElementById("ipf-cve-status-control");
    if (!el || el.hidden) return null;            // present-but-hidden => treat as absent
    const r = el.getBoundingClientRect();
    return (r && r.height > 0 && r.width > 0) ? el : null;
  }

  // Watch the CVE control for changes (it is toggled via Options, and it grows
  // when its results-toggle button appears after an evaluation) so we always
  // reposition to stay clear of it. One observer, re-targeted as needed.
  let cveObserver = null, cveObserved = null;
  function ensureCveObserver(el) {
    if (cveObserved === el) return;
    if (cveObserver) { try { cveObserver.disconnect(); } catch (_) {} cveObserver = null; }
    cveObserved = el || null;
    if (!el) return;
    try {
      cveObserver = new MutationObserver(() => {
        clearTimeout(positionLauncher._t2);
        positionLauncher._t2 = setTimeout(positionLauncher, 80);
      });
      cveObserver.observe(el, { attributes: true, childList: true, subtree: true });
    } catch (_) {}
  }

  function positionLauncher() {
    const btn = launcherBtn;
    if (!btn) return;
    const vw = window.innerWidth;

    if (!gsBarPresent()) {
      // No companion extension: centered on the IP Fabric header row (at top).
      ensureCveObserver(null);
      btn.style.top = "9px";
      btn.style.left = "50%";
      btn.style.right = "auto";
      btn.style.transform = "translateX(-50%)";
      return;
    }

    // Companion present. Its bar owns the top GS_BAR_H px (Search + LLM fields)
    // and the IP Fabric header is shifted down to GS_BAR_H. Sit on that header
    // row, below the bar.
    const cve = gsCveControl();
    ensureCveObserver(document.getElementById("ipf-cve-status-control") || null);
    const w = btn.offsetWidth || 150;
    const gap = 14;

    let top = GS_BAR_H + 11; // vertically centered in the ~52px header row
    if (cve) {
      const cr = cve.getBoundingClientRect();
      top = Math.round(cr.top + (cr.height - 30) / 2);
    }
    btn.style.top = top + "px";

    if (!cve) {
      // CVE control not shown → the header-row center is free. Use it.
      btn.style.left = "50%";
      btn.style.right = "auto";
      btn.style.transform = "translateX(-50%)";
      return;
    }

    // CVE control is centered on this row. Prefer sitting just to its right
    // (keeping a reserve for IP Fabric's own right-hand status cluster);
    // otherwise drop to the right edge just below the header rows. Either way
    // we never overlap the CVE control or the GS/LLM fields above it.
    const cr = cve.getBoundingClientRect();
    const rightReserve = 360;
    if (cr.right + gap + w <= vw - rightReserve) {
      btn.style.left = Math.round(cr.right + gap) + "px";
      btn.style.right = "auto";
      btn.style.transform = "none";
    } else {
      const cveBottom = (typeof cr.bottom === "number") ? cr.bottom : (cr.top + cr.height);
      btn.style.top = Math.round(Math.max(cveBottom, GS_BAR_H + 52) + 8) + "px";
      btn.style.left = "auto";
      btn.style.right = "16px";
      btn.style.transform = "none";
    }
  }

  function persistGeometry() {
    const r = els.wrap.getBoundingClientRect();
    const rect = { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    try { chrome.storage.sync.set({ [STORE.rect]: rect }); } catch (_) {}
  }

  function applyRect(rect) {
    els.wrap.style.top = rect.top + "px";
    els.wrap.style.left = rect.left + "px";
    els.wrap.style.right = "auto";
    els.wrap.style.width = rect.width + "px";
    els.wrap.style.height = rect.height + "px";
  }

  function restoreGeometry() {
    let applied = false;
    try {
      chrome.storage.sync.get(
        { [STORE.rect]: null, [STORE.collapsed]: false, [STORE.hidden]: true, [STORE.ignoreVol]: true, [STORE.feature]: true },
        (cfg) => {
          state.ignoreVolatile = cfg[STORE.ignoreVol] !== false;
          els.ignorevol.checked = state.ignoreVolatile;
          state.featureVisible = cfg[STORE.feature] !== false;
          if (cfg[STORE.rect] && isRectOnscreen(cfg[STORE.rect])) {
            applyRect(cfg[STORE.rect]); state.userPlaced = true; applied = true;
          } else {
            state.userPlaced = false; dockToAvailableSpace(false);
          }
          if (cfg[STORE.collapsed]) setCollapsed(true);
          // Default: panel hidden on first load. Open only if the feature is
          // enabled AND (this user had it open before, or a toggle requested it
          // while the panel was booting).
          if (state.featureVisible && (pendingShow || cfg[STORE.hidden] === false)) {
            pendingShow = false;
            setHidden(false, true);
            if (!state.userPlaced) dockToAvailableSpace(false);
            ensureLoaded();
          } else {
            setHidden(true, false);
          }
          // Finally, apply the feature's own visibility (hides the launcher +
          // keeps the panel closed when "Show Diff Dashboard" is off).
          if (launcherEl) launcherEl.style.display = state.featureVisible ? "" : "none";
          if (state.featureVisible) positionLauncher();
        }
      );
    } catch (_) {
      state.userPlaced = false;
      dockToAvailableSpace(false);
      setHidden(true, false);
    }
    // Safety: if storage callback is slow, ensure a position within a tick.
    setTimeout(() => { if (!applied && !els.wrap.style.top) dockToAvailableSpace(false); }, 50);
  }

  function isRectOnscreen(r) {
    return r && r.width >= 300 && r.top >= 0 && r.left >= 0 &&
      r.left < window.innerWidth - 60 && r.top < window.innerHeight - 30;
  }

  /* ---- Auto-dock into the free space above the data table --------------- */
  //
  // Best-effort: find the primary data table and the top-left content block
  // (e.g. the "Intent verification rules" card) and occupy the gap to the
  // right of that block and above the table — the red region in the brief.
  // Falls back to a sensible top-right anchor when the layout can't be read.
  function measureAvailableRegion() {
    try {
      const vw = window.innerWidth, vh = window.innerHeight;

      // Header bottom: the tallest fixed/sticky bar pinned near the top.
      let headerBottom = 0;
      document.querySelectorAll("body *").forEach((el) => {
        if (hostEl && (el === hostEl || hostEl.contains(el))) return;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") return;
        const r = el.getBoundingClientRect();
        if (r.top <= 2 && r.width > vw * 0.5 && r.height > 0 && r.height < 160 && r.bottom > headerBottom) {
          headerBottom = r.bottom;
        }
      });
      if (!headerBottom) headerBottom = 56;

      // Primary data table: largest visible <table> (by area).
      let table = null, bestArea = 0;
      document.querySelectorAll("table").forEach((t) => {
        if (hostEl && hostEl.contains(t)) return;
        const r = t.getBoundingClientRect();
        const area = r.width * r.height;
        if (r.width > 200 && r.height > 60 && area > bestArea) { bestArea = area; table = t; }
      });
      if (!table) return null;
      const tRect = table.getBoundingClientRect();

      // Top-left block: the widest card/section whose top is near the content
      // top and that sits above the table, on the left side.
      let leftRight = tRect.left;
      const contentTop = Math.max(headerBottom, Math.min(tRect.top - 10, headerBottom + 90));
      document.querySelectorAll("body *").forEach((el) => {
        if (hostEl && (el === hostEl || hostEl.contains(el))) return;
        const r = el.getBoundingClientRect();
        if (r.width < 180 || r.height < 60) return;
        if (r.top >= headerBottom - 4 && r.bottom <= tRect.top + 4 &&
            r.left <= tRect.left + 40 && r.right < tRect.right - 120) {
          if (r.right > leftRight) leftRight = r.right;
        }
      });

      const gap = 16;
      const left = Math.round(leftRight + gap);
      const right = Math.round(tRect.right);
      const top = Math.round(Math.max(headerBottom + 6, contentTop));
      const bottom = Math.round(tRect.top - gap);
      const width = right - left;
      const height = bottom - top;

      if (width >= 340 && height >= 130) {
        return { top, left, width: Math.min(width, 1200), height: Math.min(height, Math.max(150, vh - top - 20)) };
      }
    } catch (_) {}
    return null;
  }

  function dockToAvailableSpace(animate) {
    const region = measureAvailableRegion();
    let rect;
    if (region) {
      rect = region;
    } else {
      // Fallback: top-right anchor, reasonable default size.
      const w = Math.min(560, Math.max(360, Math.round(window.innerWidth * 0.42)));
      const top = 140;
      rect = {
        top,
        left: Math.max(10, window.innerWidth - w - 24),
        width: w,
        height: Math.min(420, window.innerHeight - top - 24),
      };
    }
    applyRect(rect);
    // Auto-dock does NOT persist: only a manual drag/resize records a rect, so
    // the panel keeps auto-fitting the available space until the user places it.
  }

  /* ===========================================================================
   * 9. Data loading into the UI
   * ========================================================================= */

  function setBusy(b, label) {
    state.busy = b;
    els.run.disabled = b || !canCompare();
    els.run.innerHTML = "";
    if (b) { els.run.appendChild(h("span", { class: "spin" })); els.run.append(" " + (label || "Comparing…")); }
    else els.run.append("Compare");
  }

  function canCompare() {
    return !!(state.availableCols.length && els.col.value && els.snapA.value && els.snapB.value &&
      els.snapA.value !== els.snapB.value);
  }

  function refreshRunEnabled() { els.run.disabled = state.busy || !canCompare(); }

  function clearResults() {
    els.summary.style.display = "none";
    els.summary.innerHTML = "";
    els.results.innerHTML = "";
    els.csv.disabled = true;
    state.lastResult = null;
  }

  function showMessage(kind, html) {
    els.msg.innerHTML = "";
    if (!html) return;
    els.msg.appendChild(h("div", { class: kind === "err" ? "err" : "note", html }));
  }

  function populateSnapshotSelect(sel, selectedId, excludeId) {
    sel.innerHTML = "";
    sel.disabled = false;
    if (!excludeId) sel.appendChild(h("option", { value: "" }, "— choose a snapshot —"));
    for (const s of state.snapshots) {
      if (excludeId && s.id === excludeId) { /* still include; user may want */ }
      const bits = [];
      bits.push(s.name || "(unnamed)");
      if (s.date) bits.push(s.date);
      const tags = [];
      if (s.loaded) tags.push("loaded");
      if (s.locked) tags.push("locked");
      const label = bits.join("  ·  ") + (tags.length ? "  [" + tags.join(", ") + "]" : "");
      const opt = h("option", { value: s.id }, label);
      if (s.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  async function loadSnapshotsAndColumns() {
    if (state.loading) return;
    state.loading = true;
    try { await _loadSnapshotsAndColumns(); }
    finally { state.loading = false; }
  }

  async function _loadSnapshotsAndColumns() {
    const det = detectTable();
    state.uiPath = det.path;
    els.sub.textContent = det.isTable ? det.path : "(open a table)";

    if (!det.isTable) {
      els.col.disabled = els.snapA.disabled = els.snapB.disabled = true;
      els.col.innerHTML = ""; els.snapA.innerHTML = ""; els.snapB.innerHTML = "";
      els.matchkey.textContent = "";
      state.matchKeys = []; state.matchKeysAuto = true; rebuildKeyEditor();
      clearResults();
      showMessage("note",
        "Open a <b>Technology</b> or <b>Inventory</b> table (for example " +
        "<code>/technology/routing/routes</code> or <code>/inventory/devices</code>) " +
        "to compare a column across snapshots.");
      refreshRunEnabled();
      state.loadedPath = det.path; // static page: no retry needed on re-open
      return;
    }

    showMessage("note", "Loading snapshots and columns…");
    clearResults();

    const snapRes = await listSnapshots();
    if (!snapRes.ok) {
      showMessage("err",
        "Could not read <code>/api/snapshots</code>" +
        (snapRes.status ? " (HTTP " + snapRes.status + ")" : "") +
        ". Make sure you are logged in to IP Fabric in this tab.");
      return;
    }
    state.snapshots = snapRes.snapshots;
    if (!state.snapshots.length) { showMessage("err", "No snapshots were returned by this IP Fabric instance."); return; }

    state.currentId = pickCurrentSnapshot(state.snapshots);
    const other = state.snapshots.find((s) => s.id !== state.currentId);
    populateSnapshotSelect(els.snapA, state.currentId, null);
    populateSnapshotSelect(els.snapB, other ? other.id : "", null);

    // Columns from the current snapshot.
    const colRes = await fetchFirstPage(det.path, state.currentId, null);
    if (!colRes.ok) {
      els.col.disabled = true; els.col.innerHTML = "";
      if (colRes.reason === "auth") {
        showMessage("err", "IP Fabric denied access to this table (HTTP " + colRes.status + "). Check your session/permissions.");
      } else {
        showMessage("err",
          "Could not resolve the IP Fabric API endpoint for <code>" + det.path + "</code>" +
          (colRes.status ? " (HTTP " + colRes.status + ")" : "") + ". This table may not be comparable.");
      }
      refreshRunEnabled();
      return;
    }
    state.apiPath = colRes.apiPath;

    // Authoritative, COMPLETE column set from IP Fabric's OpenAPI spec (the same
    // catalog the IP Fabric SDK uses). Falls back to the discovered columns if
    // the OAS can't be read on this instance.
    await ensureOas(null);
    const oas = oasColumnsFor(colRes.apiPath);
    let orderedCols, approximate = colRes.columnsApproximate, fromOas = false;
    if (oas && oas.columns && oas.columns.length) {
      const seen = new Set(), merged = [];
      for (const c of oas.columns) if (!seen.has(c)) { seen.add(c); merged.push(c); }       // OAS first (UI order)
      for (const c of colRes.columns) if (c && !seen.has(c)) { seen.add(c); merged.push(c); } // any discovered extras
      orderedCols = merged; approximate = false; fromOas = true;
    } else {
      orderedCols = colRes.columns.slice().sort((a, b) => prettify(a).localeCompare(prettify(b)));
    }
    state.availableCols = orderedCols.slice();

    // Labels: OAS per-column label (if present) → rendered-table header text →
    // prettified field name, so the dropdown matches the on-screen columns.
    const labels = {};
    if (oas && oas.labels) Object.assign(labels, oas.labels);
    const domLabels = scrapeHeaderLabels();
    for (const k in domLabels) if (!labels[k]) labels[k] = domLabels[k];
    state.colLabels = labels;

    const cols = orderedCols.filter((c) => !HIDDEN_COLUMNS.has(c));
    els.col.innerHTML = "";
    els.col.appendChild(h("option", { value: "" }, "— choose a column —"));
    for (const c of cols) {
      els.col.appendChild(h("option", { value: c }, labelFor(c) + "  (" + c + ")"));
    }
    els.col.disabled = false;

    showMessage("note",
      "Comparing against API endpoint <code>" + colRes.apiPath + "</code>. " +
      "Pick a column and a second snapshot, then press <b>Compare</b>." +
      (fromOas ? " Showing all " + cols.length + " comparable columns for this table." : "") +
      (approximate ? " <i>(This snapshot has no rows; column list is approximate.)</i>" : ""));
    // Reset the match key for the freshly-loaded table (compare column is blank
    // until the user picks one; the auto key is derived on column selection).
    state.matchKeys = []; state.matchKeysAuto = true;
    els.keyEditor.hidden = true;
    rebuildKeyEditor();
    updateMatchKeyHint();
    refreshRunEnabled();
    state.loadedPath = det.path; // loaded OK; re-opening on this route won't refetch
  }

  /* ---- Run the comparison ---------------------------------------------- */

  let runToken = 0;
  async function runCompare() {
    if (!canCompare() || state.busy) return;
    const myToken = ++runToken;
    const col = els.col.value;
    const snapA = els.snapA.value;
    const snapB = els.snapB.value;
    const identityCols = effectiveMatchKeys(col);
    const fetchCols = Array.from(new Set([...identityCols, col]));

    clearResults();
    setBusy(true, "Fetching A…");
    showMessage("note", "");
    els.results.innerHTML = "";
    const prog = h("div", { class: "progress" }, "Fetching snapshot A…");
    els.results.appendChild(prog);

    try {
      const aRes = await fetchAllRows(state.apiPath, state.uiPath, snapA, fetchCols, null,
        (n) => { if (myToken === runToken) prog.textContent = `Fetching snapshot A… ${n.toLocaleString()} rows`; });
      if (myToken !== runToken) return;
      if (!aRes.ok) throw new Error("Snapshot A fetch failed (HTTP " + aRes.status + (aRes.reason ? ", " + aRes.reason : "") + ")");

      setBusy(true, "Fetching B…");
      prog.textContent = "Fetching snapshot B…";
      const bRes = await fetchAllRows(state.apiPath, state.uiPath, snapB, fetchCols, null,
        (n) => { if (myToken === runToken) prog.textContent = `Fetching snapshot B… ${n.toLocaleString()} rows`; });
      if (myToken !== runToken) return;
      if (!bRes.ok) throw new Error("Snapshot B fetch failed (HTTP " + bRes.status + (bRes.reason ? ", " + bRes.reason : "") + ")");

      // If the compared column was dropped as invalid in either snapshot, warn.
      const droppedCol = (aRes.droppedColumns || []).includes(col) || (bRes.droppedColumns || []).includes(col);
      if (droppedCol) throw new Error("The column \"" + labelFor(col) + "\" is not present in one of the selected snapshots.");

      setBusy(true, "Comparing…");
      const diff = computeDiff(aRes.rows, bRes.rows, identityCols, col, state.ignoreVolatile);
      if (myToken !== runToken) return;

      state.lastResult = { diff, col, identityCols, snapA, snapB,
        droppedA: aRes.droppedColumns, droppedB: bRes.droppedColumns };
      renderResults();
    } catch (err) {
      if (myToken !== runToken) return;
      clearResults();
      showMessage("err", escapeHtml(err && err.message ? err.message : String(err)));
    } finally {
      if (myToken === runToken) setBusy(false);
    }
  }

  function snapName(id) {
    const s = state.snapshots.find((x) => x.id === id);
    if (!s) return id ? id.slice(0, 8) : "(unknown)";
    return (s.name || "(unnamed)") + (s.date ? " · " + s.date : "");
  }

  function renderResults() {
    const r = state.lastResult;
    if (!r) return;
    const { diff, col, identityCols, snapA, snapB } = r;
    els.msg.innerHTML = "";
    els.results.innerHTML = "";

    // Summary chips
    els.summary.style.display = "flex";
    els.summary.innerHTML = "";
    els.summary.appendChild(chip("added", `Only in A`, diff.onlyInA.length));
    els.summary.appendChild(chip("removed", `Only in B`, diff.onlyInB.length));
    els.summary.appendChild(chip("changed", `Changed`, diff.changed.length));
    els.summary.appendChild(chip("same", `Unchanged`, diff.unchanged));

    const legend = h("div", { class: "note" });
    legend.innerHTML =
      `<b>A (current):</b> ${escapeHtml(snapName(snapA))} &nbsp;•&nbsp; ` +
      `<b>B (compare):</b> ${escapeHtml(snapName(snapB))}<br>` +
      `Comparing column <b>${escapeHtml(labelFor(col))}</b> (<code>${escapeHtml(col)}</code>). ` +
      `“Only in A” = appears now but not in B. “Only in B” = was in B, gone now. ` +
      `“Changed” = the row exists in both but this column’s value differs.`;
    els.results.appendChild(legend);

    if (!diff.onlyInA.length && !diff.onlyInB.length && !diff.changed.length) {
      els.results.appendChild(h("div", { class: "empty" },
        `No differences in “${labelFor(col)}” between these two snapshots (${diff.unchanged.toLocaleString()} rows identical).`));
    }

    if (diff.changed.length) els.results.appendChild(renderChangedGroup(diff.changed, col, identityCols, snapA, snapB));
    if (diff.onlyInA.length) els.results.appendChild(renderSimpleGroup("added", "Only in A (" + snapNameShort(snapA) + ")", diff.onlyInA, col, identityCols, snapA));
    if (diff.onlyInB.length) els.results.appendChild(renderSimpleGroup("removed", "Only in B (" + snapNameShort(snapB) + ")", diff.onlyInB, col, identityCols, snapB));

    els.csv.disabled = false;
  }

  function snapNameShort(id) {
    const s = state.snapshots.find((x) => x.id === id);
    return s ? (s.name || id.slice(0, 8)) : (id ? id.slice(0, 8) : "?");
  }

  function chip(cls, label, n) {
    return h("span", { class: "chip " + cls }, label + ": ", h("b", {}, n.toLocaleString()));
  }

  function renderSimpleGroup(cls, title, items, col, identityCols, snapId) {
    const det = h("details", { class: "grp " + cls, open: items.length <= 30 ? "" : null });
    const dotColor = cls === "added" ? BRAND.added : BRAND.removed;
    det.appendChild(h("summary", {},
      h("span", { class: "dot", style: `background:${dotColor}` }),
      title,
      h("span", { class: "count" }, items.length.toLocaleString())));
    const wrap = h("div", { class: "tablewrap" });
    const tbl = h("table", { class: "res" });
    tbl.appendChild(h("tr", {},
      h("th", {}, "Row (" + identityCols.map(labelFor).join(", ") + ")"),
      h("th", {}, labelFor(col)),
      h("th", {}, "")));
    const MAX = 2000;
    items.slice(0, MAX).forEach((it) => {
      const valText = it.values.map((v) => v.disp).join("  |  ");
      const link = buildDeepLink(state.uiPath, identityCols, it.values[0] && it.values[0].row, snapId);
      tbl.appendChild(h("tr", {},
        h("td", { class: "id" }, it.display),
        h("td", { class: "val" }, valText),
        h("td", {}, link ? h("a", { class: "link", href: link, target: "_blank", rel: "noopener" }, "view ↗") : "")));
    });
    wrap.appendChild(tbl);
    det.appendChild(wrap);
    if (items.length > MAX) det.appendChild(h("div", { class: "note", style: "padding:6px 10px" }, `Showing first ${MAX.toLocaleString()} of ${items.length.toLocaleString()}. Use Export CSV for the full list.`));
    return det;
  }

  function renderChangedGroup(items, col, identityCols, snapA, snapB) {
    const det = h("details", { class: "grp changed", open: items.length <= 30 ? "" : null });
    det.appendChild(h("summary", {},
      h("span", { class: "dot", style: `background:${BRAND.changed}` }),
      "Changed",
      h("span", { class: "count" }, items.length.toLocaleString())));
    const wrap = h("div", { class: "tablewrap" });
    const tbl = h("table", { class: "res" });
    tbl.appendChild(h("tr", {},
      h("th", {}, "Row (" + identityCols.map(labelFor).join(", ") + ")"),
      h("th", {}, labelFor(col) + " — B (" + snapNameShort(snapB) + ")"),
      h("th", {}, ""),
      h("th", {}, labelFor(col) + " — A (" + snapNameShort(snapA) + ")"),
      h("th", {}, "")));
    const MAX = 2000;
    items.slice(0, MAX).forEach((it) => {
      const aVal = it.aValues.map((v) => v.disp).join("  |  ");
      const bVal = it.bValues.map((v) => v.disp).join("  |  ");
      const link = buildDeepLink(state.uiPath, identityCols, it.aValues[0] && it.aValues[0].row, snapA);
      tbl.appendChild(h("tr", {},
        h("td", { class: "id" }, it.display),
        h("td", { class: "val old" }, bVal),
        h("td", { class: "arrow" }, "→"),
        h("td", { class: "val new" }, aVal),
        h("td", {}, link ? h("a", { class: "link", href: link, target: "_blank", rel: "noopener" }, "view ↗") : "")));
    });
    wrap.appendChild(tbl);
    det.appendChild(wrap);
    if (items.length > MAX) det.appendChild(h("div", { class: "note", style: "padding:6px 10px" }, `Showing first ${MAX.toLocaleString()} of ${items.length.toLocaleString()}. Use Export CSV for the full list.`));
    return det;
  }

  /* ---- CSV export ------------------------------------------------------- */

  function exportCsv() {
    const r = state.lastResult;
    if (!r) return;
    const { diff, col, identityCols, snapA, snapB } = r;
    const rows = [];
    rows.push(["change_type", "identity", labelFor(col) + " (B / " + snapNameShort(snapB) + ")", labelFor(col) + " (A / " + snapNameShort(snapA) + ")"]);
    for (const it of diff.onlyInA) rows.push(["only_in_A", it.display, "", it.values.map((v) => v.disp).join(" | ")]);
    for (const it of diff.onlyInB) rows.push(["only_in_B", it.display, it.values.map((v) => v.disp).join(" | "), ""]);
    for (const it of diff.changed) rows.push(["changed", it.display, it.bValues.map((v) => v.disp).join(" | "), it.aValues.map((v) => v.disp).join(" | ")]);

    const csv = rows.map((r2) => r2.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const tablePart = (state.uiPath || "table").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    a.href = url;
    a.download = `snapshot-diff_${tablePart}_${col}.csv`;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 30000);
  }

  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ===========================================================================
   * 10. SPA route awareness
   * ========================================================================= */

  let lastPath = location.pathname + location.search;
  function onRouteMaybeChanged() {
    const now = location.pathname + location.search;
    if (now === lastPath) return;
    lastPath = now;
    if (!hostEl) return;
    runToken++; // cancel any in-flight compare render
    state.loadedPath = null; // data is now stale for the new route
    // Reload immediately only if the panel is visible; otherwise it reloads
    // lazily the next time the user opens it (ensureLoaded).
    if (!state.hidden) loadSnapshotsAndColumns();
  }

  function installRouteWatcher() {
    const fire = () => setTimeout(onRouteMaybeChanged, 120);
    const origPush = history.pushState, origReplace = history.replaceState;
    history.pushState = function () { const r = origPush.apply(this, arguments); fire(); return r; };
    history.replaceState = function () { const r = origReplace.apply(this, arguments); fire(); return r; };
    window.addEventListener("popstate", fire);
    // Fallback poll (some SPAs mutate the URL without History API).
    setInterval(onRouteMaybeChanged, 1500);
  }

  /* ===========================================================================
   * 11. Boot
   * ========================================================================= */

  function boot() {
    buildLauncher();          // always-visible toggle on the IP Fabric header row
    buildUI();                // the panel itself (hidden by default)
    installRouteWatcher();
    // Snapshot/column data loads lazily the first time the panel is shown
    // (ensureLoaded), or immediately if a returning user had it open — both
    // handled in restoreGeometry. Nothing is fetched while the panel is hidden.
  }

  // Toggle from the toolbar button / keyboard command.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "IPFSD_TOGGLE_PANEL") {
        if (!hostEl) { pendingShow = true; boot(); } // boot shows it once ready
        else togglePanel();
        sendResponse && sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  } catch (_) {}

  // React to geometry reset from Options.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !hostEl) return;
      if (changes[STORE.ignoreVol]) {
        state.ignoreVolatile = changes[STORE.ignoreVol].newValue !== false;
        if (els.ignorevol) els.ignorevol.checked = state.ignoreVolatile;
      }
      // Live-apply the Options → Display "Show Diff Dashboard" toggle, exactly
      // like the companion extension applies its show/hide settings.
      if (changes[STORE.feature]) {
        applyFeatureVisibility(changes[STORE.feature].newValue !== false);
      }
      // When the companion extension's own overlays are toggled (its top bar or
      // CVE control appear/disappear), our clear-space may change — reposition.
      if (changes.showCveStatus || changes.showGlobalSearch || changes.showLlmSession) {
        setTimeout(positionLauncher, 80); // let the companion update its DOM first
      }
    });
  } catch (_) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
