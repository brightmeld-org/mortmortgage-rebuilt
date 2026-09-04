// /start-application — post-auth hand-off bridge (task-018, REQ-045, FLOW-001
// steps 5-6). Reads the browser-held hand-off token from sessionStorage, POSTs
// /api/applications (task-011 consumes the token: valid → Steps 3/5/7
// pre-filled; expired/tampered → silently ignored, plain Draft), clears
// storage, and lands on /applications/:id (wizard Step 1, task-016). A missing
// token still creates a plain Draft — same contract behavior.
//
// FRAME EXTENSION (logged in frame-extensions.md): the frame's navigation notes
// the hand-off flow but exports no screen for this transient bridge — built as
// a minimal centered status card in the frame's design language.
//
// Reached from: /pre-qualify and /compare "Start an application with these
// numbers" → sign-in/sign-up (redirectTo=/start-application) → here.
import type { Metadata } from "next";
import { StartApplicationClient } from "./StartApplicationClient";

export const metadata: Metadata = {
  title: "Starting your application — MortMortgage",
};

export default function StartApplicationPage() {
  return <StartApplicationClient />;
}
