import { tr, Tx } from "../i18n";
import { basename, parentPath } from "./toolkit-io";

/** A tool's recent-file list, with the active file highlighted. Renders nothing when empty. */
export function RecentList({ title, paths, activePath, busy, onPick, onClear }: {
  title: string; paths: string[]; activePath: string | undefined; busy: boolean;
  onPick: (path: string) => void; onClear: () => void;
}) {
  if (!paths.length) return null;
  return <div className="toolkit-recents">
    <div className="toolkit-recents-head">
      <span>{title}</span>
      <button className="link-button" type="button" onClick={onClear}>{tr("Clear list")}</button>
    </div>
    <div className="toolkit-recents-list">
      {paths.map((path) => <button key={path} type="button" title={path} disabled={busy}
        className={activePath?.toLowerCase() === path.toLowerCase() ? "toolkit-recent-item active" : "toolkit-recent-item"}
        onClick={() => onPick(path)}>
        <strong>{basename(path)}</strong>
        <small>{parentPath(path)}</small>
      </button>)}
    </div>
  </div>;
}
