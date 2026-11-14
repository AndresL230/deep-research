// The data rows of the New batch panel: what Start sends, what the rows show, and which files are refused before upload.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DATASET_BYTES, uploadDataset, uploadScript, type DatasetInfo, type ScriptInfo } from "../src/api";
import { homeView } from "../src/batch/home";
import type { HomeVm } from "../src/batch/model";
import { fileKind, initialDatasetUi, inputsConfig, inputsLabel, inputsView, selectedTarget, type DatasetUi } from "../src/dataset-input";

const col = (name: string, target_problem: string | null = null) => ({ name, kind: "number" as const, n_unique: 2, missing: 0, target_problem });
const pima: DatasetInfo = { id: "pima", name: "Pima diabetes (built in)", builtin: true, rows: 768, columns: [col("glucose", "too many"), col("outcome")], target: "outcome" };
const mine: DatasetInfo = { id: "ds-0123abcd", name: "<b>mine</b>.csv", builtin: false, rows: 1200, columns: [col("size", "too many"), col("kind"), col("label")], target: "label" };
const script: ScriptInfo = { id: "sc-0123abcd", name: "train_<v2>.py", lines: 1240, imports: ["pandas", "torch"], missing_packages: ["torch"] };
const ready = (over: Partial<DatasetUi> = {}): DatasetUi => ({ ...initialDatasetUi(), datasets: [pima, mine], ...over });

afterEach(() => vi.unstubAllGlobals());

describe("the data rows of a new batch", () => {
  it("sends the chosen dataset, target and script", () => {
    expect(inputsConfig(initialDatasetUi())).toEqual({ dataset: "pima", target: null, script: null });
    expect(inputsConfig(ready())).toEqual({ dataset: "pima", target: null, script: null });
    const s = ready({ selected: mine.id });
    expect(selectedTarget(s)).toBe("label");
    expect(inputsConfig(s)).toEqual({ dataset: mine.id, target: "label", script: null });
    expect(inputsConfig({ ...s, targets: { [mine.id]: "kind" }, script })).toEqual({ dataset: mine.id, target: "kind", script: "sc-0123abcd" });
  });

  it("summarises what the batch runs on", () => {
    expect(inputsLabel(ready())).toBe("Pima diabetes · planted duplicate rows");
    expect(inputsLabel(ready({ selected: mine.id, script }))).toBe("<b>mine</b>.csv, predicting label · planted duplicate rows · starting from your script");
  });

  it("marks the selection, offers a target only for an upload, and escapes names", () => {
    expect(inputsView(ready())).not.toContain("Column to predict");
    const html = inputsView(ready({ selected: mine.id }));
    expect(html).toContain(`aria-checked="true" data-act="di-dataset" data-arg="ds-0123abcd"`);
    expect(html).toContain("&lt;b&gt;mine&lt;/b&gt;.csv");
    expect(html).not.toContain("<b>mine");
    expect(html).toContain(`<option value="size" disabled>`);
    expect(html).toContain(`<option value="label" selected>`);
    expect(html).toContain("1,200 rows, 3 columns");
  });

  it("shows the script, and what the VMs lack", () => {
    const none = inputsView(ready());
    expect(none).toContain(`data-act="di-upload" data-arg="script"`);
    expect(none).not.toContain("not installed");
    const html = inputsView(ready({ script }));
    expect(html).toContain("train_&lt;v2&gt;.py");
    expect(html).toContain("1,240 lines");
    expect(html).toContain(`data-act="di-script-remove"`);
    expect(html).toContain("This script imports torch, which is not installed");
    expect(html).not.toContain(`data-arg="script"`);
  });

  it("shows an upload error, and locks while a batch starts", () => {
    expect(inputsView(ready({ upload: { state: "error", message: "the file has 3 rows" } }))).toContain(`role="alert">the file has 3 rows`);
    expect(inputsView(ready({ upload: { state: "busy", kind: "dataset" } }))).toContain("Uploading");
    const locked = inputsView(ready({ selected: mine.id, script }), true);
    expect(locked.match(/ disabled/g)!.length).toBeGreaterThanOrEqual(5);
    expect(inputsView(initialDatasetUi())).toContain("Loading datasets");
    expect(inputsView({ ...initialDatasetUi(), loadError: "The server did not answer." })).toContain("The server did not answer.");
  });

  it("sits inside the New batch panel, above the settings", () => {
    const vm: HomeVm = { batches: { state: "ready", value: [] }, health: null, defaults: null, draft: null, estimate: null, starting: false, error: null };
    const s = ready({ selected: mine.id });
    const html = homeView(vm, { html: inputsView(s), label: inputsLabel(s) });
    expect(html).toContain("predicting label · planted duplicate rows");
    expect(html.indexOf(`data-morph-key="inputs"`)).toBeGreaterThan(html.indexOf("New batch"));
    expect(html.indexOf(`data-morph-key="inputs"`)).toBeLessThan(html.indexOf(`data-morph-key="foot"`));
    // Without the rows the panel is as it was.
    expect(homeView(vm)).toContain("Pima diabetes · planted duplicate rows");
    expect(homeView(vm)).not.toContain(`data-morph-key="inputs"`);
  });

  it("tells datasets from scripts and refuses the rest before sending them", () => {
    expect(fileKind({ name: "DATA.CSV", size: 10 })).toEqual({ kind: "dataset" });
    expect(fileKind({ name: "train.py", size: 10 })).toEqual({ kind: "script" });
    expect(fileKind({ name: "epoch_40.pth", size: 10 })).toMatchObject({ problem: expect.stringMatching(/training script/) });
    expect(fileKind({ name: "notes.docx", size: 10 })).toMatchObject({ problem: expect.stringMatching(/CSV file/) });
    expect(fileKind({ name: "big.csv", size: MAX_DATASET_BYTES + 1 })).toMatchObject({ problem: expect.stringMatching(/limit for a dataset is 20 MB/) });
    expect(fileKind({ name: "big.py", size: 300 * 1024 })).toMatchObject({ problem: expect.stringMatching(/limit for a script is 200 KB/) });
    expect(fileKind({ name: "empty.csv", size: 0 })).toMatchObject({ problem: expect.stringMatching(/empty/) });
  });

  it("uploads a dataset and a script as the request body", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/scripts") ? script : mine)));
    vi.stubGlobal("fetch", fetchMock);
    const csv = Object.assign(new Blob(["a,b\n1,2\n"]), { name: "my data.csv" });
    expect(await uploadDataset(csv)).toEqual(mine);
    const py = Object.assign(new Blob(["print(1)\n"]), { name: "train v2.py" });
    expect(await uploadScript(py)).toEqual(script);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(["/api/datasets?name=my%20data.csv", "/api/scripts?name=train%20v2.py"]);
    expect(calls[0][1].method).toBe("POST");
    expect(calls[0][1].body).toBe(csv);
    expect(calls[1][1].body).toBe(py);
  });
});
