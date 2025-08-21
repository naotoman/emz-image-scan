import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const ddbClient = new DynamoDBClient();

interface UpdateItemInput {
  TableName: string;
  Key: { [key: string]: any };
  UpdateExpression: string;
  ExpressionAttributeNames: { [key: string]: string };
  ExpressionAttributeValues: { [key: string]: any };
}

export const makeInputForUpdateItem = (
  tableName: string,
  key: string,
  keyVal: any,
  params: { [key: string]: any },
  remove?: string
): UpdateItemInput => {
  const removeExpression = remove ? `REMOVE ${remove} ` : "";
  return {
    TableName: tableName,
    Key: marshall({ [key]: keyVal }),
    UpdateExpression:
      removeExpression +
      "SET " +
      Array.from(
        { length: Object.keys(params).length },
        (_, i) => `#n${i} = :v${i}`
      ).join(", "),
    ExpressionAttributeNames: Object.keys(params).reduce((acc, curr, i) => {
      acc[`#n${i}`] = curr;
      return acc;
    }, {} as { [key: string]: string }),
    ExpressionAttributeValues: marshall(
      Object.values(params).reduce((acc, curr, i) => {
        acc[`:v${i}`] = curr;
        return acc;
      }, {} as { [key: string]: any })
    ),
  };
};

export const updateItem = async (
  tableName: string,
  key: string,
  keyVal: any,
  params: { [key: string]: any },
  remove?: string
): Promise<void> => {
  const input = makeInputForUpdateItem(tableName, key, keyVal, params, remove);
  const command = new UpdateItemCommand(input);
  await ddbClient.send(command);
};
