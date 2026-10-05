import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
