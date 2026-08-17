import {
  createKoteGatewayClient,
  type GatewayDescriptor,
  type RouteMode,
} from "@koteye/kote-gateway-opencode/core"

const route: RouteMode = "proxy"
const descriptor: GatewayDescriptor = { proxyUrl: "https://gateway.example" }

void route
void descriptor
void createKoteGatewayClient
