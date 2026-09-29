import { useLocation } from "../../lib/router";
import { Card } from "../components/UI";
import { CustomerTable } from "../components/CustomerTable";

export function CustomersPage() {
  const { query } = useLocation();
  return <Card><CustomerTable pageSize={25} initialFilter={query.get("filter") ?? "all"} /></Card>;
}
