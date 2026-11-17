import "@fontsource-variable/recursive/full.css";
import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import "./stil.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("kok")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
