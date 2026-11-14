// The data a new batch runs on, as rows inside the home screen's "New batch" panel (batch/home.ts): pick the
// built-in table or upload a CSV, choose the column to predict, and optionally add a training script for the
// agents to start from.
//
// View only (state → markup); main.ts owns the state and the events. The file picker is opened from script
// (`pickFile`), so no <input type=file> lives in the patched markup.

import "./dataset-input.css";
import { attr, esc, fmtBytes } from "./ui";
import { askIcon, askSpinner } from "./ask-icons";
import { MAX_DATASET_BYTES, MAX_SCRIPT_BYTES, type BatchConfig, type DatasetInfo, type ScriptInfo } from "./api";

export type UploadKind = "dataset" | "script";

/** The `data-act` values this view emits (main.ts handles them). */
export const DI_ACT = { dataset: "di-dataset", upload: "di-upload", scriptRemove: "di-script-remove" } as const;

export interface DatasetUi {
  /** Null until the server has answered. */
  datasets: DatasetInfo[] | null;
  loadError: string | null;
  /** The chosen dataset's id. */
  selected: string;
  /** The chosen target per dataset id. Absent: the dataset's own suggestion. */
  targets: Record<string, string>;
  /** The uploaded training script, if any. Kept for this page load only. */
  script: ScriptInfo | null;
  upload: { state: "idle" } | { state: "busy"; kind: UploadKind } | { state: "error"; message: string };
  /** A file is being dragged over the rows. */
  dragging: boolean;
}

export const initialDatasetUi = (): DatasetUi => ({
  datasets: null, loadError: null, selected: "pima", targets: {}, script: null, upload: { state: "idle" }, dragging: false,
});

export const selectedDataset = (s: DatasetUi): DatasetInfo | null => s.datasets?.find((d) => d.id === s.selected) ?? null;
export const selectedTarget = (s: DatasetUi): string | null => {
  const d = selectedDataset(s);
  return d ? s.targets[d.id] ?? d.target : null;
};

/** The part of the batch config these rows decide. Before the datasets load it is the built-in table. */
export function inputsConfig(s: DatasetUi): Pick<BatchConfig, "dataset" | "target" | "script"> {
  const d = selectedDataset(s);
  return { dataset: d?.id ?? "pima", target: d && !d.builtin ? selectedTarget(s) : null, script: s.script?.id ?? null };
}

/** The panel's one-line summary of what the batch will run on. */
export function inputsLabel(s: DatasetUi): string {
  const d = selectedDataset(s);
  const data = !d || d.builtin ? "Pima diabetes" : `${d.name}, predicting ${selectedTarget(s) ?? "?"}`;
  return [data, "planted duplicate rows", s.script ? "starting from your script" : ""].filter(Boolean).join(" · ");
}

/** What a chosen or dropped file is, or why it cannot be uploaded. Checked before it is sent. */
export function fileKind(file: { name: string; size: number }): { kind: UploadKind } | { problem: string } {
  const kind: UploadKind | null = /\.(csv|txt)$/i.test(file.name) ? "dataset" : /\.py$/i.test(file.name) ? "script" : null;
  if (/\.(pth?|ckpt|safetensors|pkl|joblib|onnx|h5)$/i.test(file.name)) {
    return { problem: "Saved model weights can't be checked on their own. Upload the training script (.py) that produced them instead." };
  }
  if (!kind) return { problem: "Choose a CSV file for the dataset or a Python file (.py) for the training script." };
  if (file.size === 0) return { problem: "That file is empty." };
  const limit = kind === "dataset" ? MAX_DATASET_BYTES : MAX_SCRIPT_BYTES;
  if (file.size > limit) return { problem: `That file is ${fmtBytes(file.size)}. The limit for a ${kind} is ${fmtBytes(limit)}.` };
  return { kind };
}

/** The rows. `locked` while a batch is starting. */
export function inputsView(s: DatasetUi, locked = false): string {
  if (!s.datasets) {
    const body = s.loadError
      ? `<p class="di-err" role="alert">${esc(s.loadError)}</p>`
      : `<p class="di-meta">${askSpinner(12)}<span>Loading datasets</span></p>`;
    return `<div class="di" data-morph-key="inputs">${body}</div>`;
  }
  const d = selectedDataset(s);
  const target = selectedTarget(s);
  const uploading = s.upload.state === "busy" ? s.upload.kind : null;
  const off = locked || uploading !== null ? " disabled" : "";
  const uploadBtn = (kind: UploadKind, label: string): string =>
    `<button type="button" class="di-chip di-chip--add" data-act="${DI_ACT.upload}" data-arg="${kind}"${off}>${uploading === kind ? askSpinner(12) : askIcon("upload", 13)}<span>${uploading === kind ? "Uploading" : label}</span></button>`;

  const chips = s.datasets.map((it) =>
    `<button type="button" class="di-chip" role="radio" aria-checked="${it.id === s.selected}" data-act="${DI_ACT.dataset}" data-arg="${attr(it.id)}"${locked ? " disabled" : ""}>${askIcon("csv", 13)}<span>${esc(it.builtin ? "Pima diabetes" : it.name)}</span></button>`).join("");

  let targetField = "";
  if (d && !d.builtin) {
    const options = d.columns.map((c) => {
      const unusable = c.target_problem !== null;
      return `<option value="${attr(c.name)}"${c.name === target ? " selected" : ""}${unusable ? " disabled" : ""}>${esc(c.name)}${unusable ? "" : ` (${c.n_unique} classes)`}</option>`;
    }).join("");
    // Keyed by dataset: a new dataset gets a new <select>, so an earlier pick cannot stick to it.
    targetField = `<div class="hm-field di-target" data-morph-key="target:${attr(d.id)}">
      <label class="hm-lbl" for="di-target">Column to predict</label>
      <div class="hm-ctl"><select class="hm-input di-select" id="di-target" data-change="target"${locked ? " disabled" : ""}>${options}</select></div>
    </div>`;
  }

  const sc = s.script;
  const scriptChip = sc
    ? `<span class="di-chip di-chip--file">${askIcon("docs", 13)}<span>${esc(sc.name)}</span><span class="di-chip-sub">${sc.lines.toLocaleString("en-US")} lines</span><button type="button" class="di-x" data-act="${DI_ACT.scriptRemove}" aria-label="Remove the training script"${locked ? " disabled" : ""}>${askIcon("close", 11, null, 2)}</button></span>`
    : uploadBtn("script", "Upload .py");
  const missing = sc?.missing_packages ?? [];
  const warn = missing.length
    ? `<p class="hm-warn" data-morph-key="warn">This script imports ${esc(missing.join(", "))}, which ${missing.length === 1 ? "is" : "are"} not installed in the agents' VMs (they have pandas, scikit-learn and matplotlib). The agents may fail or rewrite that part.</p>`
    : "";
  const error = s.upload.state === "error" ? `<p class="di-err" data-morph-key="error" role="alert">${esc(s.upload.message)}</p>` : "";
  const rows = d && !d.builtin ? `${d.rows.toLocaleString("en-US")} rows, ${d.columns.length} columns` : "";

  return `<div class="di" data-morph-key="inputs" data-drop${s.dragging ? ` data-dragging="1"` : ""}>
    <div class="di-row">
      <div class="hm-field di-grow">
        <div class="hm-lbl-row"><span class="hm-lbl" id="di-data-l">Dataset</span>${rows ? `<span class="hm-out di-rows">${rows}</span>` : ""}</div>
        <div class="di-chips" role="radiogroup" aria-labelledby="di-data-l">${chips}${uploadBtn("dataset", "Upload CSV")}</div>
      </div>
      ${targetField}
      <div class="hm-field">
        <span class="hm-lbl">Training script (optional)</span>
        <div class="di-chips">${scriptChip}</div>
      </div>
    </div>
    ${warn}${error}
  </div>`;
}

/** Open the system file picker for one file of that kind. Resolves with null when the person cancels. */
export function pickFile(kind: UploadKind): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind === "dataset" ? ".csv,text/csv" : ".py,text/x-python";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
