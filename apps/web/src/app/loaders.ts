import { ApiError } from "@remote-control-hub/api-client";
import type {
  AdminDeviceListResponse,
  AdminSystemSummaryResponse,
  AdminUserListResponse,
  AuditEventListResponse,
  CommandBatchListResponse,
  Device,
  DeviceListResponse,
  RegistrationMode,
  SessionListResponse,
} from "@remote-control-hub/contracts";
import type { LoaderFunctionArgs } from "react-router";
import { API_CLIENT } from "../lib/api-client.js";

export const registrationModeLoader = async (): Promise<{
  mode: RegistrationMode;
}> => {
  try {
    return await API_CLIENT.getPublicRegistrationMode();
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) {
      return { mode: "closed" };
    }
    throw error;
  }
};

export const devicesLoader = (): Promise<DeviceListResponse> =>
  API_CLIENT.getDevices();

export const deviceDetailLoader = async ({
  params,
}: LoaderFunctionArgs): Promise<Device> => {
  const response = await API_CLIENT.getDevices();
  const device = response.devices.find(
    (candidate) => candidate.id === params.deviceId,
  );
  if (device === undefined) {
    throw new Response("设备不存在", { status: 404 });
  }
  return device;
};

export type CommandsLoaderData = CommandBatchListResponse &
  DeviceListResponse & {
    historyAvailable: boolean;
  };

export const commandsLoader = async (): Promise<CommandsLoaderData> => {
  const devicesPromise = API_CLIENT.getDevices();
  try {
    const [commands, devices] = await Promise.all([
      API_CLIENT.getCommandBatches(),
      devicesPromise,
    ]);
    return {
      batches: commands.batches,
      devices: devices.devices,
      historyAvailable: true,
    };
  } catch (error: unknown) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 503)
    ) {
      const devices = await devicesPromise;
      return {
        batches: [],
        devices: devices.devices,
        historyAvailable: false,
      };
    }
    throw error;
  }
};

export const sessionsLoader = (): Promise<SessionListResponse> =>
  API_CLIENT.getSessions();

export const auditLoader = (): Promise<AuditEventListResponse> =>
  API_CLIENT.getAuditEvents({ limit: 50 });

export const adminOverviewLoader = (): Promise<AdminSystemSummaryResponse> =>
  API_CLIENT.getAdminSystemSummary();

export const adminUsersLoader = async (): Promise<
  AdminUserListResponse & { registrationMode: RegistrationMode }
> => {
  const [users, registration] = await Promise.all([
    API_CLIENT.getAdminUsers(),
    API_CLIENT.getRegistrationMode(),
  ]);
  return { registrationMode: registration.mode, users: users.users };
};

export const adminDevicesLoader = (): Promise<AdminDeviceListResponse> =>
  API_CLIENT.getAdminDevices();

export const adminAuditLoader = (): Promise<AuditEventListResponse> =>
  API_CLIENT.getAdminAuditEvents({ limit: 100 });
