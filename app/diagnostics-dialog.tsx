import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { tr, Tx } from "./i18n";
import { compareReports, formatComparison, parseReport, type ParsedReport } from "./diagnostics";

type Loaded = { name: string; report: ParsedReport };
// Two different cars differ in thousands of rows; past this the copied text still has them all.
const ROWS_PER_SECTION = 200;

/** One-line identity of a report: version, GPU and car, so a mixed-up pair shows at a glance. */
function summary(report: ParsedReport) {
  const value = (section: string, key: string) => report.sections.get(section)?.get(key);
  return [value("Environment", "App version") && `v${value("Environment", "App version")}`, value("WebGL", "Renderer"), value("Vehicle set", "Base")].filter(Boolean).join(" · ");
}

/** Help ▸ Compare diagnostic reports: two saved reports side by side, only the rows that differ. */
export function DiagnosticCompareDialog({ onClose }: { onClose: () => void }) {
  const [reports, setReports] = useState<[Loaded | null, Loaded | null]>([null, null]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const differences = useMemo(() => reports[0] && reports[1] ? compareReports(reports[0].report, reports[1].report) : null, [reports]);
  const sections = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof differences>>();
    for (const difference of differences ?? []) grouped.set(difference.section, [...(grouped.get(difference.section) ?? []), difference]);
    return [...grouped.entries()];
  }, [differences]);

  const choose = async (slot: 0 | 1) => {
    setError(""); setCopied(false);
    try {
      const path = await open({ multiple: false, filters: [{ name: "Diagnostic report", extensions: ["txt"] }] });
      if (!path || Array.isArray(path)) return;
      const report = parseReport(new TextDecoder().decode(await readFile(path)));
      const loaded = { name: path.replace(/^.*[\\/]/, ""), report };
      setReports((current) => slot === 0 ? [loaded, current[1]] : [current[0], loaded]);
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
  };
  const copy = async () => {
    if (!differences || !reports[0] || !reports[1]) return;
    try { await navigator.clipboard.writeText(formatComparison([reports[0].name, reports[1].name], differences)); setCopied(true); } catch { setError("Clipboard access was blocked."); }
  };

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal diagnostics-compare" onMouseDown={(event) => event.stopPropagation()}>
      <button className="modal-close" onClick={onClose}>×</button>
      <p className="eyebrow">{tr("DIAGNOSTICS")}</p>
      <h2>{tr("Compare diagnostic reports")}</h2>
      <p>{tr("Open the report from the computer where the problem happens and one made here with the same files. Only the rows that differ are listed.")}</p>
      <div className="compare-slots">
        {([0, 1] as const).map((slot) => <div key={slot} className="compare-slot">
          <strong>{slot === 0 ? "A" : "B"}</strong>
          <span title={reports[slot]?.name}>{reports[slot] ? reports[slot]!.name : tr("No report chosen")}</span>
          {reports[slot] && <small>{summary(reports[slot]!.report)}</small>}
          <button className="folder-button" onClick={() => void choose(slot)}>{tr("Choose…")}</button>
        </div>)}
      </div>
      {error && <p className="compare-error">{tr(error)}</p>}
      {differences && <>
        <div className="compare-summary">
          <span>{differences.length ? <Tx t="{0} rows differ" v={[differences.length.toLocaleString()]} /> : tr("The two reports match")}</span>
          {differences.length > 0 && <button className="folder-button" onClick={() => void copy()}>{copied ? tr("Copied") : tr("Copy as text")}</button>}
        </div>
        <div className="compare-list">
          {sections.map(([section, rows]) => <section key={section}>
            <h3>{section}</h3>
            {rows.slice(0, ROWS_PER_SECTION).map((row, index) => <div key={index} className="compare-row">
              <span className="compare-key">{row.key}</span>
              <span className={row.a === null ? "missing" : ""}><b>A</b>{row.a ?? tr("(missing)")}</span>
              <span className={row.b === null ? "missing" : ""}><b>B</b>{row.b ?? tr("(missing)")}</span>
            </div>)}
            {rows.length > ROWS_PER_SECTION && <p className="compare-more"><Tx t="{0} more in the copied text" v={[(rows.length - ROWS_PER_SECTION).toLocaleString()]} /></p>}
          </section>)}
        </div>
      </>}
    </div>
  </div>;
}
