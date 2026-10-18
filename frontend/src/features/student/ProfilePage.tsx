/** /student/profile (ADR-024): resume upload and the trainee's editable profile. */
import { LoadingState, PageHeader } from "@/components/shared";

import { useStudentContext } from "./hooks";
import { ProfileSection } from "./ProfileSection";

export function ProfilePage() {
  const { me } = useStudentContext();
  if (!me) return <LoadingState />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Profile"
        description="Upload your resume to fill your skills and career interest, then keep your profile current so matching fits you."
      />
      <ProfileSection me={me} />
    </div>
  );
}
