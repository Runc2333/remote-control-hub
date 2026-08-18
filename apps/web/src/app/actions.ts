import type { ActionFunctionArgs } from "react-router";
import { API_CLIENT } from "../lib/api-client.js";

export type RegistrationActionData =
  { kind: "failed"; message: string } | { kind: "succeeded"; message: string };

export const registrationAction = async ({
  request,
}: ActionFunctionArgs): Promise<RegistrationActionData> => {
  const form = await request.formData();
  const identifier = form.get("identifier");
  const identifierType = form.get("identifierType");
  const password = form.get("password");
  if (
    typeof identifier !== "string" ||
    (identifierType !== "email" && identifierType !== "phone") ||
    typeof password !== "string"
  ) {
    return { kind: "failed", message: "注册信息不完整。" };
  }
  try {
    await API_CLIENT.register({ identifier, identifierType, password });
    return {
      kind: "succeeded",
      message: "账号已创建，现在可以登录。邮箱或手机号当前未经过所有权验证。",
    };
  } catch {
    return {
      kind: "failed",
      message: "注册失败。平台可能已关闭开放注册，或账号信息不符合要求。",
    };
  }
};
