import { redirect } from "next/navigation";

/** There is no notifications overview yet; templates are the way in. */
export default function NotificationsPage() {
  redirect("/notifications/templates");
}
