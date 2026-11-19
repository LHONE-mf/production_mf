import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./pwa";
import App from "./App.tsx";
import { Capacitor } from "@capacitor/core";

// Android insets are already applied to the native content container.
// Keep CSS env(safe-area-inset-*) exclusively for the browser/PWA.
document.documentElement.classList.toggle("capacitor-native", Capacitor.isNativePlatform());

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
