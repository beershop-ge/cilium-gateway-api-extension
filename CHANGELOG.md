# Changelog

## 0.1.0

- Gateway API Map: a live map of a cluster's Gateway API resources, under Network in each cluster, from GatewayClass to Gateway, listeners (ListenerSets included), routes and backend Services, coloured by health.
- Select anything on the map to light up its path and see its details: conditions, route rules, endpoints ready, and what Cilium provisioned for a Gateway (LoadBalancer Service, CiliumEnvoyConfig, LB IP pool), each one click from Lens's own details.
