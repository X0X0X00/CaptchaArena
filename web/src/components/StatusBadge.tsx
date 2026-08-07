import { Badge } from "./ui/badge"

export function StatusBadge({
  submitted,
  correct,
  status,
}: {
  submitted?: boolean
  correct?: boolean
  status?: string
}) {
  if (correct) return <Badge variant="success">correct</Badge>
  if (submitted && !correct) return <Badge variant="destructive">wrong</Badge>
  if (status === "submit_not_clicked") return <Badge variant="warning">no submit</Badge>
  if (status) return <Badge variant="secondary">{status}</Badge>
  return <Badge variant="outline">running</Badge>
}
