// The names a sandbox under gVisor needs in its `/etc/hosts` (task H06, ADR-M25 §2.12). Docker's
// embedded DNS (127.0.0.11) does not answer inside a gVisor sandbox on a user-defined network; the
// gVisor FAQ names "use IPs instead of container names" as the fix. So, before the sandbox is
// created, the runner reads what is on the run's network (the egress services, the MCP gateway)
// and gives the sandbox `ExtraHosts` with the same names Docker's DNS would answer: each
// container's name and its aliases on that network. The network stays internal: a name only says
// where a container is, it opens no route. With the Engine's default runtime nothing is added.
import type { DockerClient } from '../docker/client.js';
import { HOST_NAME, isPrivateIpv4 } from '../docker/guard.js';

interface Endpoint {
  readonly IPAddress?: unknown;
  readonly Aliases?: unknown;
}

/** `name:ip` entries for every container on `network`, sorted; empty when there is none. */
export async function runNetworkHosts(docker: DockerClient, network: string): Promise<string[]> {
  const info = await docker.networkInspect(network);
  const entries = new Set<string>();
  for (const member of Object.values(info?.Containers ?? {})) {
    const container = await docker.containerInspect(member.Name);
    const endpoint = (container?.NetworkSettings.Networks[network] ?? {}) as Endpoint;
    const ip = typeof endpoint.IPAddress === 'string' ? endpoint.IPAddress : '';
    if (!isPrivateIpv4(ip)) continue;
    const aliases: readonly unknown[] = Array.isArray(endpoint.Aliases) ? endpoint.Aliases : [];
    for (const name of [member.Name, ...aliases]) {
      if (typeof name === 'string' && HOST_NAME.test(name)) entries.add(`${name}:${ip}`);
    }
  }
  return [...entries].sort();
}
