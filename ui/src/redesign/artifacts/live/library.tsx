import { createLibrary, type DefinedComponent } from "@openuidev/react-lang";
import { Button } from "@sf-openui/Button/index.js";
import { CardHeader } from "@sf-openui/CardHeader/index.js";
import { Input } from "@sf-openui/Input/index.js";
import { Select, SelectItem } from "@sf-openui/Select/index.js";
import { z } from "zod/v4";
import {
  AreaChart,
  BarChart,
  HorizontalBarChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  ScatterSeries,
  Series,
} from "./charts";
import { Card, Stack } from "./layout";
import { Callout, SectionCard, Stat, StatusPill, Tag, TextContent } from "./plain";
import { Col, Table } from "./table";

type AnyComponent = DefinedComponent;

export const liveRenderComponents = [
  Stack,
  Card,
  CardHeader,
  TextContent,
  Callout,
  Table,
  Col,
  Tag,
  Stat,
  StatusPill,
  SectionCard,
  LineChart,
  BarChart,
  HorizontalBarChart,
  PieChart,
  AreaChart,
  ScatterChart,
  RadarChart,
  Series,
  ScatterSeries,
  Select,
  SelectItem,
  Input,
  Button,
] as AnyComponent[];

function openChildArray(components: AnyComponent[]) {
  const refs = components.map((component) => component.ref);
  return z.array(z.union(refs as [typeof refs[0], typeof refs[1], ...typeof refs]));
}

const children = openChildArray(liveRenderComponents);
const stackProps = Stack.props as unknown as { shape: { children: typeof children } };
const cardProps = Card.props as unknown as { shape: { children: typeof children } };
stackProps.shape.children = children;
cardProps.shape.children = children;

export const stageflowRenderLibrary = createLibrary({
  id: "stageflow",
  root: "Stack",
  components: liveRenderComponents,
});

export function liveVocabularyPropOrder(): Array<{ name: string; props: string[] }> {
  return liveRenderComponents.map((component) => ({
    name: component.name,
    props: Object.keys((component.props as unknown as { shape: Record<string, unknown> }).shape),
  }));
}
