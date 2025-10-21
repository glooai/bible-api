import { redirect } from "next/navigation";

export default function HomePage() {
  return redirect(process.env.DEFAULT_REDIRECT_URL!);
}
