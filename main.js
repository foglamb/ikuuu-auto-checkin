// 不直接使用 Cookie 是因为 Cookie 过期时间较短。

import { appendFileSync } from "fs";

const host = process.env.HOST || "ikuuu.one";
const pushplusTokens = process.env.PUSHPLUS_TOKENS ? process.env.PUSHPLUS_TOKENS.split(',') : [];

const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

// 格式化 Cookie
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();

  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) {
      cookiePairs.set(match[1].trim(), match[2].trim());
    }
  }

  return Array.from(cookiePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

// 发送PushPlus通知
async function sendPushPlusNotification(token, title, content) {
  try {
    const response = await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: token.trim(),
        title: title,
        content: content,
        template: "markdown"
      }),
    });

    const data = await response.json();
    return data.code === 200;
  } catch (error) {
    console.error("PushPlus通知发送失败:", error.message);
    return false;
  }
}

// 登录获取 Cookie
async function logIn(account) {
  console.log(`${account.name}: 登录中...`);

  const formData = new FormData();
  formData.append("host", host);
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const response = await fetch(logInUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`网络请求出错 - ${response.status}`);
  }

  const responseJson = await response.json();

  if (responseJson.ret !== 1) {
    throw new Error(`登录失败: ${responseJson.msg}`);
  } else {
    console.log(`${account.name}: ${responseJson.msg}`);
  }

  let rawCookieArray = response.headers.getSetCookie();
  if (!rawCookieArray || rawCookieArray.length === 0) {
    throw new Error(`获取 Cookie 失败`);
  }

  return { ...account, cookie: formatCookie(rawCookieArray) };
}

// 签到
async function checkIn(account) {
  const response = await fetch(checkInUrl, {
    method: "POST",
    headers: {
      Cookie: account.cookie,
    },
  });

  if (!response.ok) {
    throw new Error(`网络请求出错 - ${response.status}`);
  }

  const data = await response.json();
  console.log(`${account.name}: ${data.msg}`);

  return data.msg;
}

// 处理单个账户
async function processSingleAccount(account) {
  const cookedAccount = await logIn(account);
  const checkInResult = await checkIn(cookedAccount);
  
  // 如果账户配置中有单独的PushPlus Token，发送单独通知
  if (account.pushplusToken) {
    const title = `iKuuu签到 - ${account.name}`;
    const content = `**${account.name} 签到结果**\n\n${checkInResult}`;
    
    console.log(`${account.name}: 发送PushPlus通知...`);
    await sendPushPlusNotification(account.pushplusToken, title, content);
  }
  
  return {
    account: account.name,
    result: checkInResult,
    pushplusSent: !!account.pushplusToken
  };
}

function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// 发送全局PushPlus通知
async function sendGlobalPushPlusNotifications(resultLines) {
  if (pushplusTokens.length === 0) return;
  
  const title = "iKuuu自动签到结果汇总";
  const content = resultLines.join("\n");
  
  for (const token of pushplusTokens) {
    if (token.trim()) {
      console.log(`发送全局PushPlus通知到: ${token.substring(0, 10)}...`);
      await sendPushPlusNotification(token, title, content);
    }
  }
}

// 入口
async function main() {
  console.log("开始执行签到任务...");
  console.log(`Host: ${host}`);
  
  let accounts;

  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("❌ 未配置账户信息。");
    }

    console.log("ACCOUNTS环境变量内容:", process.env.ACCOUNTS.substring(0, 50) + "...");
    
    // 尝试解析账户信息
    accounts = JSON.parse(process.env.ACCOUNTS);
    
    if (!Array.isArray(accounts)) {
      throw new Error("账户信息应该是一个数组");
    }
    
    console.log(`找到 ${accounts.length} 个账户`);
    
  } catch (error) {
    const message = `❌ 账户信息配置格式错误: ${error.message}\n\n请确保ACCOUNTS是一个有效的JSON数组，格式如下：\n\n[{\n  "name": "用户名",\n  "email": "邮箱",\n  "passwd": "密码"\n}]`;
    console.error(message);
    setGitHubOutput("result", message);
    process.exit(1);
  }

  const allPromises = accounts.map((account) => processSingleAccount(account));
  const results = await Promise.allSettled(allPromises);

  const msgHeader = "\n======== 签到结果 ========\n\n";
  console.log(msgHeader);

  let hasError = false;

  const resultLines = results.map((result, index) => {
    const account = accounts[index];
    const accountName = account.name;

    const isSuccess = result.status === "fulfilled";

    if (!isSuccess) {
      hasError = true;
    }

    const icon = isSuccess ? "✅" : "❌";
    const message = isSuccess ? result.value.result : result.reason.message;

    const line = `${accountName}: ${icon} ${message}`;

    isSuccess ? console.log(line) : console.error(line);

    return line;
  });

  const resultMsg = resultLines.join("\n");

  // 发送全局PushPlus通知
  await sendGlobalPushPlusNotifications(resultLines);

  setGitHubOutput("result", resultMsg);

  if (hasError) {
    console.log("部分账户签到失败");
    process.exit(1);
  } else {
    console.log("所有账户签到成功");
  }
}

main().catch(error => {
  console.error("程序执行出错:", error);
  process.exit(1);
});