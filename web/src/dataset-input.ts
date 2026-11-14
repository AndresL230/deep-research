// The data a new batch runs on, as rows inside the home screen's "New batch" panel (batch/home.ts): pick the
// built-in table or upload a CSV, choose the column to predict, and optionally add a training script for the
// agents to start from.
//
// The robot arm domain has one row instead (`controllerRow`): the person's own controller.py for the agents to
// start from.
//
// View only (state → markup); main.ts owns the state and the events. The file picker is opened from script
// (`pickFile`), so no <input type=file> lives in the patched markup.

import "./dataset-input.css";
import { attr, esc, fmtBytes } from "./ui";
import { askIcon, askSpinner } from "./ask-icons";
import { MAX_DATASET_BYTES, MAX_SCRIPT_BYTES, type BatchConfig, type ControllerInfo, type DatasetInfo, type ScriptInfo } from "./api";
import { DEFAULT_PLANTED } from "./batch/trap";

/** What a file is uploaded as. A .py file reads as a script (`fileKind`); main.ts sends it as the controller in the
 *  robot domain instead. */
export type UploadKind = "dataset" | "script" | "controller";

/** The `data-act` values this view emits (main.ts handles them). */
export const DI_ACT = {
  dataset: "di-dataset", upload: "di-upload", scriptRemove: "di-script-remove", controllerRemove: "di-controller-remove",
} as const;

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
  /** The uploaded robot controller, if any (robot arm domain). Kept for this page load only, like the script. */
  controller: ControllerInfo | null;
  upload: { state: "idle" } | { state: "busy"; kind: UploadKind } | { state: "error"; message: string };
  /** A file is being dragged over the rows. */
  dragging: boolean;
}

export const initialDatasetUi = (): DatasetUi => ({
  datasets: null, loadError: null, selected: "pima", targets: {}, script: null, controller: null, upload: { state: "idle" }, dragging: false,
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

/** The panel's one-line summary of what the batch will run on. The trap is not chosen in these rows, so the summary
 *  names the default one; home.ts puts the chosen trap's words in its place. */
export function inputsLabel(s: DatasetUi): string {
  const d = selectedDataset(s);
  const data = !d || d.builtin ? "Pima diabetes" : `${d.name}, predicting ${selectedTarget(s) ?? "?"}`;
  return [data, DEFAULT_PLANTED, s.script ? "starting from your script" : ""].filter(Boolean).join(" · ");
}

/** What a finished upload brings back. */
export type Uploaded =
  | { kind: "dataset"; info: DatasetInfo }
  | { kind: "script"; info: ScriptInfo }
  | { kind: "controller"; info: ControllerInfo };

/** Taken when an upload starts: its number, and the dataset that was chosen then. */
export interface UploadTicket { seq: number; selected: string }

/**
 * The state once an upload has finished, built from the state as it is now: what the person changed while the file
 * was on its way is kept. `latestSeq` is the number of the newest upload, and the result of an older one is dropped.
 * A new dataset is always added to the choices, but it becomes the chosen one only if the person did not pick
 * another one meanwhile.
 */
export function withUpload(now: DatasetUi, ticket: UploadTicket, latestSeq: number, done: Uploaded): DatasetUi {
  if (ticket.seq !== latestSeq) return now;
  const upload = { state: "idle" } as const;
  if (done.kind === "script") return { ...now, script: done.info, upload };
  if (done.kind === "controller") return { ...now, controller: done.info, upload };
  const selected = now.selected === ticket.selected ? done.info.id : now.selected;
  return { ...now, datasets: [...(now.datasets ?? []), done.info], selected, upload };
}

/** The upload state after the person changes a row: an old error goes, but an upload on its way stays busy. */
export const uploadAfterEdit = (u: DatasetUi["upload"]): DatasetUi["upload"] => (u.state === "busy" ? u : { state: "idle" });

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

/** The dashed "Upload ..." chip for one kind of file; a spinner while that kind is on its way. */
function uploadChip(s: DatasetUi, kind: UploadKind, label: string, locked: boolean): string {
  const uploading = s.upload.state === "busy" ? s.upload.kind : null;
  const off = locked || uploading !== null ? " disabled" : "";
  return `<button type="button" class="di-chip di-chip--add" data-act="${DI_ACT.upload}" data-arg="${kind}"${off}>${uploading === kind ? askSpinner(12) : askIcon("upload", 13)}<span>${uploading === kind ? "Uploading" : label}</span></button>`;
}

/** An uploaded file as a chip: its name, its line count and a remove button. */
function fileChip(info: { name: string; lines: number }, removeAct: string, removeLabel: string, locked: boolean): string {
  return `<span class="di-chip di-chip--file">${askIcon("docs", 13)}<span>${esc(info.name)}</span><span class="di-chip-sub">${info.lines.toLocaleString("en-US")} lines</span><button type="button" class="di-x" data-act="${removeAct}" aria-label="${attr(removeLabel)}"${locked ? " disabled" : ""}>${askIcon("close", 11, null, 2)}</button></span>`;
}

/** The warning under an uploaded file whose imports the VMs lack. `have` names what they do have. */
function missingWarn(what: string, missing: string[], have: string): string {
  if (!missing.length) return "";
  return `<p class="hm-warn" data-morph-key="warn">This ${what} imports ${esc(missing.join(", "))}, which ${missing.length === 1 ? "is" : "are"} not installed in the agents' VMs (they have ${have}). The agents may fail or rewrite that part.</p>`;
}

const uploadError = (s: DatasetUi): string =>
  s.upload.state === "error" ? `<p class="di-err" data-morph-key="error" role="alert">${esc(s.upload.message)}</p>` : "";

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
  const uploadBtn = (kind: UploadKind, label: string): string => uploadChip(s, kind, label, locked);

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
  const scriptChip = sc ? fileChip(sc, DI_ACT.scriptRemove, "Remove the training script", locked) : uploadBtn("script", "Upload .py");
  const warn = missingWarn("script", sc?.missing_packages ?? [], "pandas, scikit-learn and matplotlib");
  const error = uploadError(s);
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

/**
 * The robot arm domain's one row, in the tabular rows' place: the person's own controller.py, or the chip to upload
 * one. `locked` while a batch is starting. The upload error shows here too, since the tabular rows are not drawn then.
 */
export function controllerRow(s: DatasetUi, locked = false): string {
  const ct = s.controller;
  const chip = ct ? fileChip(ct, DI_ACT.controllerRemove, "Remove the controller", locked) : uploadChip(s, "controller", "Upload controller.py", locked);
  const warn = missingWarn("controller", ct?.missing_packages ?? [], "numpy and mujoco");
  return `<div class="di" data-morph-key="controller" data-drop${s.dragging ? ` data-dragging="1"` : ""}>
    <div class="di-row">
      <div class="hm-field">
        <span class="hm-lbl">Your controller (optional)</span>
        <div class="di-chips">${chip}</div>
      </div>
    </div>
    ${warn}${uploadError(s)}
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
