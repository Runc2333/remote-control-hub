import { ApiError } from "@remote-control-hub/api-client";
import type {
  Session,
  SetupStatusResponse,
} from "@remote-control-hub/contracts";
import { redirect, type LoaderFunctionArgs } from "react-router";
import { API_CLIENT } from "../lib/api-client.js";

export type BootstrapData = {
  sessions: Session[];
  setup: SetupStatusResponse;
};

export const bootstrapLoader = async (): Promise<BootstrapData> => {
  const [, setup] = await Promise.all([
    API_CLIENT.getHealth(),
    API_CLIENT.getSetupStatus(),
  ]);
  if (!setup.installed) {
    return { sessions: [], setup };
  }
  try {
    const { sessions } = await API_CLIENT.getSessions();
    return { sessions, setup };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return { sessions: [], setup };
    }
    throw error;
  }
};

export const currentSession = (data: BootstrapData): Session | undefined =>
  data.sessions.find((session) => session.current);

type PageLoader<Result> = (args: LoaderFunctionArgs) => Promise<Result>;

const requireSession = async (): Promise<Session> => {
  try {
    const response = await API_CLIENT.getSessions();
    const session = response.sessions.find((candidate) => candidate.current);
    if (session === undefined) {
      throw redirect("/login");
    }
    return session;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect("/login");
    }
    if (error instanceof ApiError && error.status === 404) {
      throw redirect("/setup");
    }
    throw error;
  }
};

export const authenticatedLoader =
  <Result>(loader: PageLoader<Result>): PageLoader<Result> =>
  async (args) => {
    await requireSession();
    return loader(args);
  };

export const administratorLoader =
  <Result>(loader: PageLoader<Result>): PageLoader<Result> =>
  async (args) => {
    const session = await requireSession();
    if (session.role !== "admin") {
      throw redirect("/devices");
    }
    return loader(args);
  };
