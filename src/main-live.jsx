import React from "react";
import { createRoot } from "react-dom/client";
import LivePage from "./LivePage.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LivePage />
  </React.StrictMode>,
);
