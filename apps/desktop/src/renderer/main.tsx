import "./theme.css";
import "./styles/redesign.css";
import "./monaco-setup";
import React from "react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installPreviewBridge } from "./previewBridge";

installPreviewBridge();

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[ORVYN renderer]", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{height:"100%",padding:32,background:"#0B0E14",color:"#E8EAF3",fontFamily:"Segoe UI, sans-serif"}}>
        <h1 style={{marginTop:0}}>ORVYN could not render the workspace</h1>
        <p style={{color:"#A0A7BB"}}>The renderer hit an error. The details below are safe to copy into the run log or ZCode.</p>
        <pre style={{whiteSpace:"pre-wrap",padding:16,border:"1px solid #2F3749",borderRadius:8,background:"#0C1018",color:"#F0806E"}}>{this.state.error.message}</pre>
        <button onClick={() => window.location.reload()} style={{padding:"10px 14px",borderRadius:8,border:"1px solid #465068",background:"#5563F5",color:"#fff",cursor:"pointer"}}>Reload ORVYN</button>
      </div>
    );
  }
}
const root = document.getElementById("root");
if (!root) throw new Error("ORVYN renderer root element is missing");
createRoot(root).render(<RootErrorBoundary><App /></RootErrorBoundary>);
