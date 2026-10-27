import { MotionConfig } from "motion/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { AutomationEditorPage } from "./pages/AutomationEditor";
import { AutomationsPage } from "./pages/Automations";
import { CampaignEditorPage } from "./pages/CampaignEditor";
import { CampaignsPage } from "./pages/Campaigns";
import { Customer360Page } from "./pages/Customer360";
import { CustomersPage } from "./pages/Customers";
import { LegacyEmailRedirect, TemplateEditorPage } from "./pages/Emails";
import { HomePage } from "./pages/Home";
import { AnalyticsPage, ChartBuilderPage } from "./pages/Analytics";
import { SettingsPage } from "./pages/Settings";
import { LivePage } from "./pages/Live";
import { AgentCustomerPage, ServiceCustomersPage, ServiceDeskPage } from "./pages/Service";

export function App() {
  return (
    <ErrorBoundary full>
    <MotionConfig reducedMotion="user">
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/campaigns/:id" element={<CampaignEditorPage />} />
          <Route path="/emails" element={<Navigate to="/settings?tab=templates" replace />} />
          <Route path="/emails/:id" element={<LegacyEmailRedirect />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/automations/:id" element={<AutomationEditorPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:id" element={<Customer360Page />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/analytics/new" element={<ChartBuilderPage key="new" />} />
          <Route path="/analytics/:id" element={<ChartBuilderPage />} />
          <Route path="/performance" element={<Navigate to="/analytics" replace />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/service" element={<ServiceDeskPage />} />
          <Route path="/service/customers" element={<ServiceCustomersPage />} />
          <Route path="/service/customers/:id" element={<AgentCustomerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/templates/:id" element={<TemplateEditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </MotionConfig>
    </ErrorBoundary>
  );
}
