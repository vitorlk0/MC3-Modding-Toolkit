import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { tr, Tx } from "./i18n";

/**
 * Help ▸ About: what the toolkit is, how it edits, and who made it possible. The credits follow the
 * OBJ2PCK site's wording, plus the authors of the community scripts this app ports.
 */

type Credit = { who: string; what: string };

const research: Credit[] = [
  { who: "Bruno [@offlbruno] & ZNX [@znxee]", what: "Research, discovery and primary investigation of the game's PCK files, as well as the base code that made this tool possible." },
];

const ported: Credit[] = [
  { who: "Performance Editor v1.1", what: "@ZNXee171 & @mc3rxx — the VehSim / VehGyro / VehZone layout behind the Performance tab." },
  { who: "dave.py", what: "EdnessP — the DAVE archive format, and the layout the Vehicle DAT Builder reproduces byte for byte." },
  { who: "MC3 ISO Direct Explorer", what: "RibeiroG — the first tool to patch ASSETS.DAT straight inside the ISO, and the reference for ISO Install." },
];

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => undefined); }, []);
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal about" onMouseDown={(event) => event.stopPropagation()}>
      <button className="modal-close" onClick={onClose}>×</button>
      <p className="eyebrow">{version ? `${tr("VERSION")} ${version}` : tr("MID ENGINE")}</p>
      <h2>{tr("MC3 Modding Toolkit")}</h2>
      <p>{tr("A desktop workspace for Midnight Club 3: DUB Edition Remix car mods — from converted meshes and anchors to performance, audio, textures, menus and opponent setups, through to installing the finished cars into the game's ISO.")}</p>
      <div className="about-rule" />
      <p><strong>{tr("Editing model:")}</strong> {tr("every change lives in memory until you save. Nothing on disk is touched before that.")}</p>
      <p><strong>{tr("On save:")}</strong> {tr("every file is written, then read back and compared byte for byte before it counts as saved.")}</p>
      <p><strong>{tr("Offline:")}</strong> {tr("everything runs on your computer; no file is ever uploaded.")}</p>
      <div className="about-rule" />
      <p className="eyebrow">{tr("RESEARCH CREDITS")}</p>
      <h3 className="about-heading">{tr("Built on community investigation")}</h3>
      <div className="about-credits">
        {research.map((credit) => <p key={credit.who}><strong>{credit.who}</strong><span>{tr(credit.what)}</span></p>)}
        {ported.map((credit) => <p key={credit.who}><strong>{credit.who}</strong><span>{tr(credit.what)}</span></p>)}
        <p><strong>{tr("Special thanks")}</strong><span><Tx t="Almightypear, Rato.jpg {0} RibeiroG." v={[tr("and")]} /></span></p>
        <p><strong>{tr("Toolkit vibecoded by")}</strong><span>{tr("@mid_engine — youtube.com/@mid_engine")}</span></p>
      </div>
    </div>
  </div>;
}
