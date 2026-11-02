import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./app.css";
import { Dashboard } from "./pages/Dashboard";
import { Invite } from "./pages/Invite";
import { Login } from "./pages/Login";
import { Team } from "./pages/Team";
import { FullScreenMessage, RequireAuth, SessionProvider } from "./session";

// The canvas bundle is heavy: load it only when a board is opened.
const BoardPage = lazy(() => import("./board/BoardPage"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/invite/:token" element={<Invite />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/team"
            element={
              <RequireAuth>
                <Team />
              </RequireAuth>
            }
          />
          <Route
            path="/b/:id"
            element={
              <RequireAuth>
                <Suspense fallback={<FullScreenMessage>Abriendo tablero…</FullScreenMessage>}>
                  <BoardPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route path="*" element={<FullScreenMessage>Página no encontrada</FullScreenMessage>} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  </StrictMode>,
);
