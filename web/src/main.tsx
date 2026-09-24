import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./cms.css";
import App from "./App";
import { installErrorReporting } from "./errorReporting";

installErrorReporting();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
