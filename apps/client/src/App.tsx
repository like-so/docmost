import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/layouts/global/layout.tsx";
import { Error404 } from "@/components/ui/error-404.tsx";
import { useTranslation } from "react-i18next";
import { useTrackOrigin } from "@/hooks/use-track-origin";

const SetupWorkspace = lazy(() => import("@/pages/auth/setup-workspace.tsx"));
const LoginPage = lazy(() => import("@/pages/auth/login"));
const Home = lazy(() => import("@/pages/dashboard/home"));
const Page = lazy(() => import("@/pages/page/page"));
const AccountSettings = lazy(
  () => import("@/pages/settings/account/account-settings"),
);
const WorkspaceMembers = lazy(
  () => import("@/pages/settings/workspace/workspace-members"),
);
const WorkspaceSettings = lazy(
  () => import("@/pages/settings/workspace/workspace-settings"),
);
const Groups = lazy(() => import("@/pages/settings/group/groups"));
const GroupInfo = lazy(() => import("./pages/settings/group/group-info"));
const Spaces = lazy(() => import("@/pages/settings/space/spaces.tsx"));
const AccountPreferences = lazy(
  () => import("@/pages/settings/account/account-preferences.tsx"),
);
const SpaceHome = lazy(() => import("@/pages/space/space-home.tsx"));
const PageRedirect = lazy(() => import("@/pages/page/page-redirect.tsx"));
const InviteSignup = lazy(() => import("@/pages/auth/invite-signup.tsx"));
const ForgotPassword = lazy(() => import("@/pages/auth/forgot-password.tsx"));
const PasswordReset = lazy(() => import("./pages/auth/password-reset"));
const Security = lazy(() => import("@/pages/settings/security/security.tsx"));
const SharedPage = lazy(() => import("@/pages/share/shared-page.tsx"));
const Shares = lazy(() => import("@/pages/settings/shares/shares.tsx"));
const ShareLayout = lazy(
  () => import("@/features/share/components/share-layout.tsx"),
);
const ShareRedirect = lazy(() => import("@/pages/share/share-redirect.tsx"));
const PublicSpacePage = lazy(
  () => import("@/pages/public-space/public-space-page.tsx"),
);
const PublicSpaceLayout = lazy(
  () => import("@/features/public-space/components/public-space-layout.tsx"),
);
const PublicSpaceDirectoryPage = lazy(
  () => import("@/pages/public-space/public-space-directory-page.tsx"),
);
const SpacesPage = lazy(() => import("@/pages/spaces/spaces.tsx"));
const MfaChallengePage = lazy(() => import("@/pages/auth/mfa-challenge.tsx"));
const MfaSetupRequiredPage = lazy(
  () => import("@/pages/auth/mfa-setup-required.tsx"),
);
const SpaceTrash = lazy(() => import("@/pages/space/space-trash.tsx"));
const ApiKeys = lazy(() => import("@/pages/settings/api-keys/api-keys"));
const ApiKeyManagement = lazy(
  () => import("@/pages/settings/api-keys/api-key-management"),
);
const OAuthClients = lazy(() => import("@/pages/settings/oauth/oauth-clients"));
const AuthorizedApps = lazy(
  () => import("@/pages/settings/oauth/authorized-apps"),
);
const AiSettings = lazy(() => import("@/pages/settings/ai/ai-settings.tsx"));
const BasePage = lazy(() => import("@/features/base/pages/base-page.tsx"));
const AuditLogs = lazy(() => import("@/pages/settings/audit/audit.tsx"));
const PageVerificationPage = lazy(
  () => import("@/pages/page-verification/page-verification-page"),
);
const PersonalSpacePage = lazy(
  () => import("@/pages/personal-space/personal-space-page"),
);
const TemplatesPage = lazy(() => import("@/pages/templates/templates-page"));
const FavoritesPage = lazy(() => import("@/pages/favorites/favorites-page"));
const AiChat = lazy(() => import("@/features/ai/pages/ai-chat.tsx"));
const VerifyEmail = lazy(() => import("@/pages/auth/verify-email.tsx"));
const LabelPage = lazy(() => import("@/pages/label/label-page"));
const OAuthConsent = lazy(() => import("@/pages/oauth/consent.tsx"));

export default function App() {
  const { t } = useTranslation();
  useTrackOrigin();

  useEffect(() => {
    // warm the editor chunk so opening a page doesn't wait on the network
    const timer = setTimeout(() => import("@/pages/page/page"), 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route index element={<Navigate to="/home" />} />
        <Route path={"/login"} element={<LoginPage />} />
        <Route path={"/invites/:invitationId"} element={<InviteSignup />} />
        <Route path={"/forgot-password"} element={<ForgotPassword />} />
        <Route path={"/password-reset"} element={<PasswordReset />} />
        <Route path={"/login/mfa"} element={<MfaChallengePage />} />
        <Route path={"/login/mfa/setup"} element={<MfaSetupRequiredPage />} />
        <Route path={"/oauth/consent"} element={<OAuthConsent />} />

        <Route path={"/setup/register"} element={<SetupWorkspace />} />
        <Route path={"/verify-email"} element={<VerifyEmail />} />

        <Route element={<ShareLayout />}>
          <Route
            path={"/share/:shareId/p/:pageSlug"}
            element={<SharedPage />}
          />
          <Route path={"/share/p/:pageSlug"} element={<SharedPage />} />
        </Route>

        <Route path={"/docs"} element={<PublicSpaceDirectoryPage />} />
        <Route element={<PublicSpaceLayout />}>
          <Route path={"/docs/:spaceSlug"} element={<PublicSpacePage />} />
          <Route
            path={"/docs/:spaceSlug/:pageSlug"}
            element={<PublicSpacePage />}
          />
        </Route>

        <Route path={"/share/:shareId"} element={<ShareRedirect />} />
        <Route path={"/p/:pageSlug"} element={<PageRedirect />} />

        <Route element={<Layout />}>
          <Route path={"/home"} element={<Home />} />
          <Route path={"/ai"} element={<AiChat />} />
          <Route path={"/ai/chat/:chatId"} element={<AiChat />} />
          <Route path={"/spaces"} element={<SpacesPage />} />
          <Route path={"/favorites"} element={<FavoritesPage />} />
          <Route path={"/labels/:labelName"} element={<LabelPage />} />
          <Route path={"/templates"} element={<TemplatesPage />} />
          <Route path={"/templates/:templateId"} element={<TemplatesPage />} />
          <Route path={"/personal"} element={<PersonalSpacePage />} />
          <Route path={"/s/:spaceSlug"} element={<SpaceHome />} />
          <Route path={"/s/:spaceSlug/trash"} element={<SpaceTrash />} />
          <Route path={"/s/:spaceSlug/p/:pageSlug"} element={<Page />} />

          <Route path={"/base/:pageId"} element={<BasePage />} />

          <Route path={"/settings"}>
            <Route path={"account/profile"} element={<AccountSettings />} />
            <Route
              path={"account/preferences"}
              element={<AccountPreferences />}
            />
            <Route path={"account/api-keys"} element={<ApiKeys />} />
            <Route
              path={"account/api-keys/authorized-apps"}
              element={<AuthorizedApps />}
            />
            <Route path={"workspace"} element={<WorkspaceSettings />} />
            <Route path={"members"} element={<WorkspaceMembers />} />
            <Route path={"api-keys"} element={<ApiKeyManagement />} />
            <Route path={"oauth-clients"} element={<OAuthClients />} />
            <Route path={"groups"} element={<Groups />} />
            <Route path={"groups/:groupId"} element={<GroupInfo />} />
            <Route path={"spaces"} element={<Spaces />} />
            <Route path={"sharing"} element={<Shares />} />
            <Route path={"security"} element={<Security />} />
            <Route path={"ai"} element={<AiSettings />} />
            <Route path={"ai/mcp"} element={<AiSettings />} />
            <Route path={"audit"} element={<AuditLogs />} />
            <Route path={"audit/siem"} element={<AuditLogs />} />
            <Route
              path={"siem"}
              element={<Navigate to="/settings/audit/siem" replace />}
            />
            <Route path={"verifications"} element={<PageVerificationPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Error404 />} />
      </Routes>
    </Suspense>
  );
}
