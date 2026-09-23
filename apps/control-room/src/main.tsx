import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { App } from "./app";
import { ConnectionProvider } from "./connection";
import "./styles.css";
import "./confirmations.css";

const root = document.getElementById("root");
if (!root) throw new Error("Control Room root element is missing");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </BrowserRouter>
  </StrictMode>,
);
