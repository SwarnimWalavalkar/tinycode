import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "./style.css";
import { App } from "./App";
import { startConnection } from "./state";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
void startConnection();
