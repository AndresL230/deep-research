// OWNER: subagent A. The home screen (batch list + config form + estimate + Start) and the header cost bar.
import type { Costs } from "../api";
import type { HomeVm } from "./model";

/** The home screen: saved and live batches to open, and the config screen to start a new one. */
export function homeView(vm: HomeVm): string {
  void vm;
  return "";
}

/** The cost bar shown in the header on every batch screen: spent so far against the budget. */
export function costBar(costs: Costs, opts: { simulated: boolean }): string {
  void costs; void opts;
  return "";
}
