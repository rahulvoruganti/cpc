import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { ProtectedRoute } from "./components/ProtectedRoute.jsx";
import ChatWidget from "./components/ChatWidget.jsx";
import LogPanel from "./components/LogPanel.jsx";
import FailureNotifier from "./components/FailureNotifier.jsx";

import Login from "./pages/Login.jsx";
import EntraCallback from "./pages/EntraCallback.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Provision from "./pages/Provision.jsx";
import Resources from "./pages/Resources.jsx";
import Admin from "./pages/Admin.jsx";
import Audit from "./pages/Audit.jsx";
import Requests from "./pages/Requests.jsx";

// Floating widgets (chat + activity log) only render when signed in.
function GlobalOverlays() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <ChatWidget />
      <LogPanel />
      <FailureNotifier />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/entra/callback" element={<EntraCallback />} />

          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/provision" element={<ProtectedRoute><Provision /></ProtectedRoute>} />
          <Route path="/resources" element={<ProtectedRoute><Resources /></ProtectedRoute>} />
          <Route path="/requests" element={<ProtectedRoute><Requests /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute adminOnly><Admin /></ProtectedRoute>} />
          <Route path="/audit" element={<ProtectedRoute adminOnly><Audit /></ProtectedRoute>} />
          {/* Legacy paths now live as tabs under /admin */}
          <Route path="/users" element={<Navigate to="/admin?tab=users" replace />} />
          <Route path="/mappings" element={<Navigate to="/admin?tab=mappings" replace />} />
        </Routes>
        <GlobalOverlays />
      </BrowserRouter>
    </AuthProvider>
  );
}
