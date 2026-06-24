/**
 * Git URL 解析工具
 *
 * 解析各种格式的 Git 仓库 URL，提取 host、path、ref 等结构化信息。
 * 支持的格式：
 * - SCP 风格：git@github.com:user/repo
 * - HTTPS/HTTP：https://github.com/user/repo
 * - SSH：ssh://git@github.com/user/repo
 * - git: 前缀：git:github.com/user/repo
 * - ref 后缀：URL#branch 或 URL@tag
 *
 * 使用 hosted-git-info 库识别 GitHub、GitLab、Bitbucket 等托管平台。
 *
 * 调用方：包管理器解析 git 扩展源时调用。
 */

import hostedGitInfo from "hosted-git-info";

/** 解析后的 Git 源信息 */
export type GitSource = {
	/** 类型标识，始终为 "git" */
	type: "git";
	/** 克隆 URL（有效的 git clone 地址，不含 ref 后缀） */
	repo: string;
	/** Git 主机域名（如 "github.com"） */
	host: string;
	/** 仓库路径（如 "user/repo"） */
	path: string;
	/** Git ref（分支、标签、提交哈希），未指定时为 undefined */
	ref?: string;
	/** 是否指定了 ref（指定后不会自动更新） */
	pinned: boolean;
};

/**
 * 从 URL 中分离仓库地址和 ref。
 *
 * 支持三种 URL 格式的 ref 提取：
 * - SCP 风格：git@host:path@ref
 * - 协议 URL：https://host/path@ref
 * - 简写形式：host/path@ref
 *
 * @param url - 原始 URL 字符串
 * @returns 包含 repo（不含 ref 的地址）和可选 ref 的对象
 */
function splitRef(url: string): { repo: string; ref?: string } {
	// SCP 风格：git@host:path@ref
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	// 协议 URL：https://host/path@ref
	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			return { repo: url };
		}
	}

	// 简写形式：host/path@ref
	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) {
		return { repo: url };
	}
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}
	return {
		repo: `${host}/${repoPath}`,
		ref,
	};
}

/**
 * 通用 Git URL 解析（非托管平台的回退方案）。
 *
 * 从 URL 中提取 host 和 path，支持 SCP 风格、协议 URL 和简写形式。
 *
 * @param url - Git URL 字符串
 * @returns 解析后的 GitSource 对象，无法解析时返回 null
 */
function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	// SCP 风格：git@host:path
	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (
		repoWithoutRef.startsWith("https://") ||
		repoWithoutRef.startsWith("http://") ||
		repoWithoutRef.startsWith("ssh://") ||
		repoWithoutRef.startsWith("git://")
	) {
		// 协议 URL
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		// 简写形式：host/path（host 必须包含 "." 或为 "localhost"）
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}
		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}
		repo = `https://${repoWithoutRef}`;
	}

	// 标准化路径：去除 .git 后缀和前导斜杠
	const normalizedPath = path.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !normalizedPath || normalizedPath.split("/").length < 2) {
		return null;
	}

	return {
		type: "git",
		repo,
		host,
		path: normalizedPath,
		ref,
		pinned: Boolean(ref),
	};
}

/**
 * 解析 Git 源 URL 为结构化的 GitSource 对象。
 *
 * 解析规则：
 * - 带 git: 前缀：接受所有历史简写形式
 * - 不带 git: 前缀：仅接受明确的协议 URL（https://、ssh:// 等）
 *
 * 优先使用 hosted-git-info 识别 GitHub、GitLab 等托管平台，
 * 无法识别时回退到通用解析。
 *
 * @param source - Git 源 URL 字符串
 * @returns 解析后的 GitSource 对象，无法解析时返回 null
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = trimmed.startsWith("git:");
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

	// 非 git: 前缀时，只接受明确的协议 URL
	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	const split = splitRef(url);

	// 尝试用 hosted-git-info 解析（识别 GitHub/GitLab/Bitbucket 等）
	const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of hostedCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			// 跳过 ref 中包含 "@" 的误解析（如 npm scoped package）
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			// 判断是否需要添加 https:// 前缀
			const useHttpsPrefix =
				!split.repo.startsWith("http://") &&
				!split.repo.startsWith("https://") &&
				!split.repo.startsWith("ssh://") &&
				!split.repo.startsWith("git://") &&
				!split.repo.startsWith("git@");
			return {
				type: "git",
				repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
				host: info.domain || "",
				path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
				ref: info.committish || split.ref || undefined,
				pinned: Boolean(info.committish || split.ref),
			};
		}
	}

	// 尝试添加 https:// 前缀后用 hosted-git-info 解析
	const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : undefined, `https://${url}`].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of httpsCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			return {
				type: "git",
				repo: `https://${split.repo}`,
				host: info.domain || "",
				path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
				ref: info.committish || split.ref || undefined,
				pinned: Boolean(info.committish || split.ref),
			};
		}
	}

	// 回退到通用 Git URL 解析
	return parseGenericGitUrl(url);
}
