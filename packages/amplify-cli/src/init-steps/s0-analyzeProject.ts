import * as path from 'path';
import * as fs from 'fs-extra';
import * as inquirer from 'inquirer';
import { InvalidEnvironmentNameError, stateManager, exitOnNextTick, $TSContext } from 'amplify-cli-core';
import { normalizeEditor, editorSelection } from '../extensions/amplify-helpers/editor-selection';
import { isProjectNameValid, normalizeProjectName } from '../extensions/amplify-helpers/project-name-validation';
import { amplifyCLIConstants } from '../extensions/amplify-helpers/constants';

export async function analyzeProjectHeadless(context: $TSContext) {
  const projectPath = process.cwd();
  const projectName = path.basename(projectPath);
  const env = getDefaultEnv(context);
  setProjectConfig(context, projectName);
  setExeInfo(context, projectPath, undefined, env);
  // default behavior in quickstart used to be android.
  // default to that here unless different param specified
  const { frontend } = context?.parameters?.options;
  if (!frontend) {
    context.print.warning('No frontend specified. Defaulting to android.');
    context.exeInfo.projectConfig.frontend = 'android';
  } else {
    context.exeInfo.projectConfig.frontend = frontend;
  }
}

export async function analyzeProject(context): Promise<$TSContext> {
  if (!context.parameters.options.app || !context.parameters.options.quickstart) {
    context.print.warning('Note: It is recommended to run this command from the root of your app directory');
  }
  const projectPath = process.cwd();
  context.exeInfo.isNewProject = isNewProject(context);
  const projectName = await getProjectName(context);
  const envName = await getEnvName(context);

  let defaultEditor = getDefaultEditor();

  if (!defaultEditor) {
    defaultEditor = await getEditor(context);
  }

  context.exeInfo.isNewEnv = isNewEnv(envName);
  context.exeInfo.forcePush = !!context?.parameters?.options?.forcePush;

  // If it is a new env and we have an existing environment save that name so
  // it can be used to gather resource information like env specific to clone import resources
  if (context.exeInfo.isNewEnv && !context.exeInfo.isNewProject) {
    const currentLocalEnvInfo = stateManager.getLocalEnvInfo(undefined, {
      throwIfNotExist: false,
    });

    if (currentLocalEnvInfo) {
      context.exeInfo.sourceEnvName = currentLocalEnvInfo.envName;
    }
  }

  setProjectConfig(context, projectName);
  setExeInfo(context, projectPath, defaultEditor, envName);

  return context;
}

function setProjectConfig(context: $TSContext, projectName: string) {
  context.exeInfo.isNewProject = isNewProject(context);
  context.exeInfo.projectConfig = {
    projectName,
    version: amplifyCLIConstants.CURRENT_PROJECT_CONFIG_VERSION,
  };
}

function setExeInfo(context: $TSContext, projectPath: String, defaultEditor?: String, envName?: String) {
  context.exeInfo.localEnvInfo = {
    projectPath,
    defaultEditor,
    envName,
  };
  context.exeInfo.teamProviderInfo = {};
  context.exeInfo.metaData = {};

  return context;
}

/* Begin getProjectName */
async function getProjectName(context) {
  let projectName;
  const projectPath = process.cwd();

  if (!context.exeInfo.isNewProject) {
    const projectConfig = stateManager.getProjectConfig(projectPath);

    projectName = projectConfig.projectName;

    return projectName;
  }

  if (context.exeInfo.inputParams.amplify && context.exeInfo.inputParams.amplify.projectName) {
    projectName = normalizeProjectName(context.exeInfo.inputParams.amplify.projectName);
  } else {
    projectName = normalizeProjectName(path.basename(projectPath));

    if (!context.exeInfo.inputParams.yes) {
      const projectNameQuestion: inquirer.InputQuestion = {
        type: 'input',
        name: 'inputProjectName',
        message: 'Enter a name for the project',
        default: projectName,
        validate: input => isProjectNameValid(input) || 'Project name should be between 3 and 20 characters and alphanumeric',
      };

      const answer = await inquirer.prompt(projectNameQuestion);

      projectName = answer.inputProjectName;
    }
  }

  return projectName;
}
/* End getProjectName */

/* Begin getEditor */
async function getEditor(context) {
  let editor;
  if (context.exeInfo.inputParams.amplify && context.exeInfo.inputParams.amplify.defaultEditor) {
    editor = normalizeEditor(context.exeInfo.inputParams.amplify.defaultEditor);
  } else if (!context.exeInfo.inputParams.yes) {
    editor = await editorSelection(editor);
  }

  return editor;
}
/* End getEditor */

function getDefaultEnv(context): string | undefined {
  const defaultEnv = 'dev';
  if (isNewProject(context) || !context.amplify.getAllEnvs().includes(defaultEnv)) {
    return defaultEnv;
  }
  return undefined;
}

async function getEnvName(context) {
  let envName;

  const isEnvNameValid = inputEnvName => {
    return /^[a-z]{2,10}$/.test(inputEnvName);
  };

  const INVALID_ENV_NAME_MSG = 'Environment name must be between 2 and 10 characters, and lowercase only.';

  if (context.exeInfo.inputParams.amplify && context.exeInfo.inputParams.amplify.envName) {
    if (isEnvNameValid(context.exeInfo.inputParams.amplify.envName)) {
      ({ envName } = context.exeInfo.inputParams.amplify);
      return envName;
    }
    context.print.error(INVALID_ENV_NAME_MSG);
    await context.usageData.emitError(new InvalidEnvironmentNameError(INVALID_ENV_NAME_MSG));
    exitOnNextTick(1);
  } else if (context.exeInfo.inputParams && context.exeInfo.inputParams.yes) {
    context.print.error('Environment name missing');
    await context.usageData.emitError(new InvalidEnvironmentNameError(INVALID_ENV_NAME_MSG));
    exitOnNextTick(1);
  }

  const newEnvQuestion = async () => {
    let defaultEnvName = getDefaultEnv(context);
    const envNameQuestion: inquirer.InputQuestion = {
      type: 'input',
      name: 'envName',
      message: 'Enter a name for the environment',
      default: defaultEnvName,
      validate: input => (!isEnvNameValid(input) ? INVALID_ENV_NAME_MSG : true),
    };

    ({ envName } = await inquirer.prompt(envNameQuestion));
  };

  if (isNewProject(context)) {
    await newEnvQuestion();
  } else {
    const allEnvs = context.amplify.getAllEnvs();

    if (allEnvs.length > 0) {
      if (await context.amplify.confirmPrompt('Do you want to use an existing environment?')) {
        const envQuestion: inquirer.ListQuestion = {
          type: 'list',
          name: 'envName',
          message: 'Choose the environment you would like to use:',
          choices: allEnvs,
        };

        ({ envName } = await inquirer.prompt(envQuestion));
      } else {
        await newEnvQuestion();
      }
    } else {
      await newEnvQuestion();
    }
  }

  return envName;
}

function isNewEnv(envName) {
  let newEnv = true;
  const projectPath = process.cwd();
  const teamProviderInfo = stateManager.getTeamProviderInfo(projectPath, {
    throwIfNotExist: false,
    default: {},
  });

  if (teamProviderInfo[envName]) {
    newEnv = false;
  }

  return newEnv;
}

function isNewProject(context) {
  let newProject = true;
  const projectPath = process.cwd();
  const projectConfigFilePath = context.amplify.pathManager.getProjectConfigFilePath(projectPath);
  if (fs.existsSync(projectConfigFilePath)) {
    newProject = false;
  }
  return newProject;
}

function getDefaultEditor() {
  const projectPath = process.cwd();
  const localEnvInfo = stateManager.getLocalEnvInfo(projectPath, {
    throwIfNotExist: false,
    default: {},
  });

  return localEnvInfo.defaultEditor;
}
