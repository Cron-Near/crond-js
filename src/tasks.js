import * as config from './configuration'
import * as agent from './agent'
import * as util from './util'
import { utils } from 'near-api-js'
import chalk from 'chalk'

export async function rpcFunction(method, args, isView, gas = BASE_GAS_FEE, amount = BASE_ATTACHED_PAYMENT) {
  const account = args.account || args.account_id || args.agent_account_id || AGENT_ACCOUNT_ID
  const manager = await getCronManager(account, args)
  const params = method === 'unregister' ? {} : util.removeUnneededArgs(args)
  let res
  if (LOG_LEVEL === 'debug') console.log(account, isView, manager[method], params, gas, amount);

  try {
    res = isView
      ? await manager[method](params)
      : await manager[method]({
        args: params,
        gas,
        amount: utils.format.parseNearAmount(`${amount}`),
      })
  } catch (e) {
    if (e && e.panic_msg) {
      log('\n')
      log('\t' + chalk.red(e.panic_msg.split(',')[0].replace('panicked at ', '').replace(/\'/g, '')))
      log('\n')
    }
    if (LOG_LEVEL === 'debug') console.log('rpcFunction', e);
  }

  if (res && !isView) return res
  if (!res && !isView) log('\n\t' + chalk.green(`${method} Success!`) + '\n')
  if (!res && isView) log(chalk.green(`No response data`))

  if (isView && res) {
    try {
      const payload = typeof res === 'object' ? res : JSON.parse(res)

      if (method === 'get_agent') {
        const balance = await getAgentBalance()
        const formattedBalance = utils.format.formatNearAmount(balance)
        payload.wallet_balance = formattedBalance
      }

      if (payload.balance) {
        payload.reward_balance = utils.format.formatNearAmount(payload.balance)
        delete payload.balance
      }

      log('\n')
      Object.keys(payload).forEach(k => {
        log(`${chalk.bold.white(k.replace(/\_/g, ' '))}: ${chalk.white(payload[k])}`)
      })
      log('\n')
    } catch (ee) {
      log(`${chalk.bold.white(method.replace(/\_/g, ' '))}: ${chalk.white(res)}`)
      if (LOG_LEVEL === 'debug') console.log('rpcFunction view:', ee);
    }
  }

  if (method === 'get_agent') {
    // Check User Balance
    const balance = await getAgentBalance()

    // ALERT USER is their balance is lower than they should be
    if (!balance || balance < 3e24) {
      log(`${chalk.bold.red('Attention!')}: ${chalk.redBright('Please add more funds to your account to continue sending transactions')}`)
      log(`${chalk.bold.red('Current Account Balance:')}: ${chalk.redBright(utils.format.formatNearAmount(balance))}\n`)

      await notifySlack(`*Attention!* Please add more funds to your account to continue sending transactions.\nCurrent Account Balance: *${utils.format.formatNearAmount(balance)}*`)
    }
  }
}

// returns if agent should skip next call or not
export const getTasks = async () => {
  const manager = await util.getCronManager()
  const agentId = config.AGENT_ACCOUNT_ID
  let skipThisIteration = false
  let totalTasks = 0
  let taskRes

  try {
    // Only get task hashes my agent can execute
    taskRes = await manager.get_agent_tasks({ account_id: agentId })
  } catch (e) {
    console.log(`${chalk.red('Connection interrupted, trying again soon...')}`)
    if (config.LOG_LEVEL === 'debug') console.log('getTasks', e);
    // Wait, then try loop again.
    skipThisIteration = true
    return;
  }
  totalTasks = parseInt(taskRes[0])
  if (taskRes[1] === '0') console.log(`${chalk.gray(new Date().toISOString())} Available Tasks: ${chalk.red(totalTasks)}, Current Slot: ${chalk.red('Paused')}`)
  else console.log(`${chalk.gray(new Date().toISOString())} ${chalk.gray('[' + manager.account.connection.networkId.toUpperCase() + ']')} Available Tasks: ${chalk.blueBright(totalTasks)}, Current Slot: ${chalk.yellow(taskRes[1])}`)

  if (config.LOG_LEVEL === 'debug') console.log('taskRes', taskRes)
  if (totalTasks <= 0) skipThisIteration = true

  return skipThisIteration
}

// returns if agent should skip next call or not
export const proxyCall = async () => {
  const manager = await util.getCronManager()
  let skipThisIteration = false

  try {
    const res = await manager.proxy_call({
      args: {},
      gas: BASE_GAS_FEE,
      amount: BASE_ATTACHED_PAYMENT,
    })
    if (config.LOG_LEVEL === 'debug') console.log(res)
    if (config.LOG_LEVEL === 'debug') console.log(`${chalk.yellowBright('TX:' + res.transaction_outcome.id)}`)
  } catch (e) {
    if (config.LOG_LEVEL === 'debug') console.log('proxy_call issue', e)
    // Check if the agent should slow down to wait for next slot opportunity
    if (e.type && e.type === 'FunctionCallError') {
      // Check if we need to skip iteration based on max calls in this slot, so we dont waste more fees.
      if (e.kind.ExecutionError.search('Agent has exceeded execution for this slot') > -1) {
        skipThisIteration = true
      }
    }
  }

  return skipThisIteration
}

export async function run() {
  let skipThisIteration = false

  // 1. Check for tasks
  skipThisIteration = await getTasks()
  if (skipThisIteration) return setTimeout(run, config.WAIT_INTERVAL_MS)

  // 2. Check agent status
  // TODO: Change - to only check if KICKED, needs to store local agent state
  // skipThisIteration = await checkAgent()
  // if (skipThisIteration) return setTimeout(run, config.WAIT_INTERVAL_MS)

  // 3. Sign task and submit to chain
  if (!skipThisIteration) skipThisIteration = await proxyCall()

  // 4. Wait, then loop again.
  // Run immediately if executed tasks remain for this slot, then sleep until next slot.
  const nextAttemptInterval = skipThisIteration ? config.WAIT_INTERVAL_MS : 100
  setTimeout(run, nextAttemptInterval)
}
