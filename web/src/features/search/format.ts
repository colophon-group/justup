import type { Salary } from "../../api/types.ts";
export function salaryText(salary: Salary | null): string {
  if (!salary || (salary.min === null && salary.max === null)) return "";
  const format = (value: number) =>
    new Intl.NumberFormat("en", { maximumFractionDigits: 20 }).format(value);
  const amount =
    salary.min !== null && salary.max !== null
      ? salary.min === salary.max
        ? format(salary.min)
        : `${format(salary.min)}–${format(salary.max)}`
      : format(salary.min ?? salary.max ?? 0);
  return `${salary.min === null ? "Up to " : salary.max === null ? "From " : ""}${salary.currency ? salary.currency + " " : ""}${amount}${salary.period ? " / " + salary.period : ""}`;
}
export function ageText(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value)),
    minutes = Math.floor(elapsed / 60000);
  return minutes < 60
    ? `${minutes}m`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h`
      : `${Math.floor(minutes / 1440)}d`;
}
