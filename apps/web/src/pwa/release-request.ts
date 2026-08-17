type ReleaseResourceReference = {
  url: string;
};

export const isRequiredReleaseRequest = (
  requestUrl: URL,
  requestMode: RequestMode,
  resources: ReadonlyArray<ReleaseResourceReference>,
): boolean =>
  requestMode === "navigate" ||
  (requestUrl.search.length === 0 &&
    resources.some((resource) => resource.url === requestUrl.pathname));
