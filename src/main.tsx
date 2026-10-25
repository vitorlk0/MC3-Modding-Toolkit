import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../app/page";
import { installDiagnosticCapture } from "../app/diagnostics";
import "../app/globals.css";

// Before anything renders, so the diagnostic report has every warning from startup on.
installDiagnosticCapture();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
