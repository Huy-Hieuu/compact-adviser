import { type ExtensionAPI, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { installAdviser } from "./adviser.ts";
import { installFirstmateAdvisers } from "./firstmate-adviser.ts";

export default function compactAdviser(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const firstmate = installFirstmateAdvisers(pi, { agentDir });
  installAdviser(pi, { agentDir, version: VERSION, stowFirst: firstmate.stowFirst });
}
