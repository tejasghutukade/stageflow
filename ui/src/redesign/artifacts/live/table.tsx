import { useState } from "react";
import { defineComponent } from "@openuidev/react-lang";
import { ScrollableTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openuidev/react-ui/Table";
import { z } from "zod/v4";
import { liveTextWrap } from "./plain";

type Column = { label: string; data: unknown[] };

function asNodes(value: unknown): Array<{ props?: Record<string, unknown> }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object") as Array<{ props?: Record<string, unknown> }>;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

export const Col = defineComponent({
  name: "Col",
  description: "Table column. data is one value per row, or a plucked array.",
  props: z.object({
    label: z.string(),
    data: z.any(),
    type: z.enum(["string", "number", "action"]).nullable().optional(),
  }),
  component: () => null,
});

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function compareCells(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return cellText(left).localeCompare(cellText(right));
}

export const Table = defineComponent({
  name: "Table",
  description: "Column-oriented table. Each Col holds its own data array.",
  props: z.object({
    columns: z.array(Col.ref),
  }),
  component: ({ props, renderNode }) => {
    const columns: Column[] = asNodes(props.columns).map((node) => ({
      label: typeof node.props?.label === "string" ? node.props.label : "",
      data: asList(node.props?.data),
    }));
    const rowCount = columns.length === 0 ? 0 : Math.max(...columns.map((column) => column.data.length));
    const [sort, setSort] = useState<{ index: number; direction: "asc" | "desc" } | null>(null);
    if (rowCount === 0) {
      return <p data-sf-component="Table" data-sf-state="no-data" className="text-[13px] text-[var(--sf-text-2)]">No data</p>;
    }
    const order = Array.from({ length: rowCount }, (_, index) => index);
    if (sort) {
      const column = columns[sort.index];
      if (column) {
        order.sort((left, right) => {
          const delta = compareCells(column.data[left], column.data[right]);
          return sort.direction === "asc" ? delta : -delta;
        });
      }
    }
    return (
      <div data-sf-component="Table">
        <ScrollableTable>
          <TableHeader>
            <TableRow>
              {columns.map((column, index) => {
                const active = sort?.index === index ? sort.direction : null;
                return (
                  <TableHead key={column.label + String(index)} aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : "none"}>
                    <button
                      type="button"
                      className="text-left"
                      onClick={() => {
                        setSort((current) => {
                          if (!current || current.index !== index) return { index, direction: "asc" };
                          if (current.direction === "asc") return { index, direction: "desc" };
                          return null;
                        });
                      }}
                    >
                      {column.label}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.map((row) => (
              <TableRow key={row}>
                {columns.map((column, index) => {
                  const cell = column.data[row];
                  const objectCell = typeof cell === "object" && cell !== null;
                  return (
                    <TableCell key={index}>
                      <span style={liveTextWrap}>{objectCell ? renderNode(cell) : cellText(cell)}</span>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </ScrollableTable>
      </div>
    );
  },
});
