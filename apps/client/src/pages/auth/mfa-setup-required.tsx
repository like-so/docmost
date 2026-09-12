import { Container } from "@mantine/core";
import { useLocation } from "react-router-dom";
import { AuthLayout } from "@/features/auth/components/auth-layout.tsx";
import classes from "@/features/auth/components/auth.module.css";
import { MfaSettings } from "@/features/security/components/mfa-settings.tsx";

export default function MfaSetupRequiredPage() {
  const { state } = useLocation();
  const setupId =
    state?.setupId ??
    new URLSearchParams(window.location.hash.slice(1)).get("setupId");
  return (
    <AuthLayout>
      <Container size={420} className={classes.container}>
        <MfaSettings setupId={setupId ?? undefined} />
      </Container>
    </AuthLayout>
  );
}
