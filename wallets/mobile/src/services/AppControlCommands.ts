export type AppControlCommandType =
  | "open_element"
  | "open_screen"
  | "open_product"
  | "add_to_cart"
  | "start_booking"
  | "open_checkout"
  | "open_cart"
  | "open_orders"
  | "open_qr_station"
  | "open_venue_pass"
  | "new_chat";

export interface AppControlCommand {
  type: AppControlCommandType;
  elementType?: string;
  target?: string;
  screen?: string;
  productId?: string;
  serviceId?: string;
  stationCode?: string;
  quantity?: number;
  query?: string;
  message?: string;
  raw?: Record<string, unknown>;
}

export interface ParsedAssistantControlPayload {
  message: string;
  commands: AppControlCommand[];
}

const VALID_TYPES = new Set<AppControlCommandType>([
  "open_element", "open_screen", "open_product", "add_to_cart",
  "start_booking", "open_checkout", "open_cart", "open_orders",
  "open_qr_station", "open_venue_pass", "new_chat",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function command(value: unknown): AppControlCommand | undefined {
  const input = record(value);
  if (!input) return undefined;
  const nested = input.appCommand ?? input.app_command ?? input.appControl ?? input.app_control;
  if (nested && nested !== input) return command(nested);
  const target = text(input.target) ?? text(input.view) ?? text(input.screen) ?? text(input.element) ?? text(input.elementType);
  const rawType = text(input.type) ?? text(input.action_type) ?? text(input.actionType);
  const normalized = rawType?.toLowerCase().replace(/[.\s-]+/g, "_");
  const type = normalized === "navigate" || normalized === "navigate_screen"
    ? "open_screen"
    : normalized === "show_element" || normalized === "navigate_element"
      ? "open_element"
      : normalized;
  if (!type || !VALID_TYPES.has(type as AppControlCommandType)) return undefined;
  return {
    type: type as AppControlCommandType,
    elementType: text(input.elementType) ?? text(input.element_type) ?? (type === "open_element" ? target : undefined),
    target,
    screen: text(input.screen),
    productId: text(input.productId) ?? text(input.product_id),
    serviceId: text(input.serviceId) ?? text(input.service_id),
    stationCode: text(input.stationCode) ?? text(input.station_code),
    quantity: typeof input.quantity === "number" && Number.isFinite(input.quantity) ? input.quantity : undefined,
    query: text(input.query),
    message: text(input.message),
    raw: input,
  };
}

export function extractAppControlCommandsFromPayload(payload: unknown): AppControlCommand[] {
  const input = record(payload);
  if (!input) return [];
  const candidates = Array.isArray(input.commands) ? input.commands : [input.command ?? input];
  return candidates.map(command).filter((value): value is AppControlCommand => Boolean(value));
}

export function parseAssistantControlPayload(textValue: string): ParsedAssistantControlPayload | undefined {
  try {
    const payload: unknown = JSON.parse(textValue);
    const input = record(payload);
    if (!input) return undefined;
    const commands = extractAppControlCommandsFromPayload(input);
    if (!commands.length) return undefined;
    return { message: text(input.message) ?? text(input.text) ?? "", commands };
  } catch {
    return undefined;
  }
}
