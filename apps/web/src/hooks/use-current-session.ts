import type { Session } from "@remote-control-hub/contracts";
import { useOutletContext } from "react-router";

export const useCurrentSession = (): Session => useOutletContext<Session>();
