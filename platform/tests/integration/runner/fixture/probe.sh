#!/bin/sh
# Probes of the C04 live egress test (ADR-M25 §2.2). Reads "name host port" lines from
# /workspace/probe-targets (uploaded by the runner before the start) and prints one line each:
# probe:<name>:open|blocked.
while read -r name host port; do
  [ -z "$name" ] && continue
  if nc -z -w 3 "$host" "$port" 2>/dev/null; then echo "probe:$name:open"; else echo "probe:$name:blocked"; fi
done < /workspace/probe-targets
route=$(ip route 2>/dev/null | awk '/^default/ {print $3}')
echo "probe:default_route:${route:-none}"
if touch /rootfs-write-test 2>/dev/null; then echo "probe:rootfs:writable"; else echo "probe:rootfs:readonly"; fi
if touch /workspace/.write-test 2>/dev/null; then echo "probe:workspace:writable"; else echo "probe:workspace:readonly"; fi
echo "probe:uid:$(id -u)"
# O01 (ADR-M91): the limits and the dropped capabilities as the kernel applies them, so a Docker
# Engine that accepts a limit but cannot enforce it (rootless Docker without cgroup delegation)
# fails the test. cgroup v2 files of the container's own cgroup; "none" when a file is missing.
for limit in memory.max memory.swap.max pids.max cpu.max; do
  value=$(tr ' ' '/' < "/sys/fs/cgroup/$limit" 2>/dev/null)
  echo "probe:$(echo "$limit" | tr . _):${value:-none}"
done
echo "probe:cap_eff:$(awk '/^CapEff:/ {print $2}' /proc/self/status)"
echo "probe:no_new_privs:$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)"
# H06 (ADR-M25 §2.12): the kernel the sandbox sees; under gVisor it is not the Engine's kernel.
echo "probe:kernel:$(uname -r)"
branch=$(sed 's#^ref: refs/heads/##' /workspace/.git/HEAD 2>/dev/null)
echo "probe:branch:${branch:-none}"
if grep -qiE 'extraheader|authorization' /workspace/.git/config 2>/dev/null; then echo "probe:git_auth:present"; else echo "probe:git_auth:absent"; fi
readme=$(head -n 1 /workspace/README.md 2>/dev/null)
echo "probe:readme:${readme:-none}"
if env | grep -q "c04-canary"; then echo "probe:canary:present"; else echo "probe:canary:absent"; fi
if env | grep -qiE "^(SDLC_OPENBAO|VAULT|BAO|ANTHROPIC|OPENAI|LITELLM|GITHUB|GH)_"; then echo "probe:secret_env:present"; else echo "probe:secret_env:absent"; fi
echo "probe:done"
echo ok > /tmp/index.html
exec httpd -f -p 8000 -h /tmp
