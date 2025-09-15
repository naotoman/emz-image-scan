import {
  InvokeCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import * as ddb from "./dynamodb-utils";

interface Item {
  id: string;
  orgUrl: string;
  ebaySku: string;
  isImageChanged: boolean;
  isTitleChanged: boolean;
  orgImageUrls: string[];
  orgTitle: string;
  weightGram: number;
  boxSizeCm: number[];
  ebayCategory: string;
  ebayStoreCategory: string;
  scannedAt?: string;
  scanCount?: number;
  ebayCondition: string;
  ebayConditionDescription?: string;
  ebayImageUrls: string[];
  ebayAspectParam: Record<string, unknown>;
  ebayTitle: string;
  ebayDescription: string;
}

interface ItemData {
  id: string;
  seller: {
    id: number;
    num_sell_items: number;
    ratings: {
      good: number;
    };
    num_ratings: number;
  };
  status: string;
  name: string;
  price: number;
  description: string;
  photos: string[];
  item_category_ntiers: {
    id: number;
    name: string;
  };
  parent_categories_ntiers: [
    {
      id: number;
      name: string;
    }
  ];
  item_condition: {
    id: number;
    name: string;
    subname: string;
  };
  shipping_payer: {
    id: number;
    name: string;
    code: string;
  };
  shipping_method: {
    id: number;
    name: string;
    is_deprecated: string;
  };
  shipping_from_area: {
    id: number;
    name: string;
  };
  shipping_duration: {
    id: number;
    name: string;
    min_days: number;
    max_days: number;
  };
  item_brand?: { id: number; name: string; sub_name: string };
  num_likes: number;
  num_comments: number;
  updated: number;
  created: number;
  auction_info?: Record<string, unknown>;
}

interface IsEligible {
  isEligible: boolean;
}

interface OfferPart {
  pricingSummary: {
    price: { currency: "USD"; value: string };
  };
  listingPolicies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
    bestOfferTerms: {
      bestOfferEnabled: false;
    };
  };
}

interface EbayListResult {
  listingId: string;
}

interface EbayOrdersResult {
  skus: string[];
}

const TABLE_NAME = process.env.TABLE_NAME!;
const LAMBDA_GET_NEXT_ITEM = process.env.LAMBDA_GET_NEXT_ITEM!;
const LAMBDAS_MERC_ITEM = process.env.LAMBDAS_MERC_ITEM!.split(",");
const LAMBDA_EBAY_DELETE = process.env.LAMBDA_EBAY_DELETE!;
const LAMBDA_EBAY_LIST = process.env.LAMBDA_EBAY_LIST!;
const LAMBDA_GET_EBAY_ORDERS = process.env.LAMBDA_GET_EBAY_ORDERS!;
const LAMBDA_IS_ELIGIBLE_FOR_LISTING =
  process.env.LAMBDA_IS_ELIGIBLE_FOR_LISTING!;
const LAMBDA_OFFER_PART = process.env.LAMBDA_OFFER_PART!;

let SIGTERM_RECEIVED = false;
process.on("SIGTERM", () => {
  console.log("SIGTERM received");
  SIGTERM_RECEIVED = true;
});

const lambdaClient = new LambdaClient();

const getFormattedDate = (date: Date): string => {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  };
  return date.toLocaleString("ja-JP", options).replaceAll("/", "-");
};

const runLambda = async (
  functionName: string,
  payload: Record<string, any>
) => {
  const command = new InvokeCommand({
    FunctionName: functionName,
    Payload: JSON.stringify(payload),
  });
  const response = await lambdaClient.send(command);
  const res_text = new TextDecoder("utf-8").decode(response.Payload);
  if (JSON.parse(res_text).errorMessage) {
    throw new Error(res_text);
  }
  const res_obj = JSON.parse(res_text);
  if (!res_obj.success) {
    throw new Error(`Lambda function ${functionName} failed.`);
  }
  return res_obj.result;
};

async function updateFunction(functionName: string) {
  const cmd = new UpdateFunctionConfigurationCommand({
    FunctionName: functionName,
    Description: `${Math.random()}`,
  });
  await lambdaClient.send(cmd);
}

async function waitLoop(lastRunAt: number) {
  const elapsedTime = Date.now() - lastRunAt;
  const randomTime = Math.floor(Math.random() * 1000) + 2000;
  if (elapsedTime < randomTime) {
    console.log(`waitLoop. sleep for ${randomTime - elapsedTime}ms`);
    await new Promise((resolve) =>
      setTimeout(resolve, randomTime - elapsedTime)
    );
  }
}

async function main() {
  const ordersResult: EbayOrdersResult = await runLambda(
    LAMBDA_GET_EBAY_ORDERS,
    {
      account: "main",
    }
  );
  console.log(JSON.stringify({ ordersResult }));

  let nextApiFuncIndex = 0;
  let lastRunAt = 0;
  while (true) {
    if (SIGTERM_RECEIVED) {
      console.log("Poling ended because of SIGTERM");
      break;
    }

    const nextItem: Item = await runLambda(LAMBDA_GET_NEXT_ITEM, {});
    console.log({ nextItem: nextItem.id });

    if (ordersResult.skus.includes(nextItem.ebaySku)) {
      console.log(`Item with SKU ${nextItem.ebaySku} is sold.`);
      continue;
    }

    waitLoop(lastRunAt);
    lastRunAt = Date.now();

    const apiFunc = LAMBDAS_MERC_ITEM[nextApiFuncIndex];
    nextApiFuncIndex = (nextApiFuncIndex + 1) % LAMBDAS_MERC_ITEM.length;
    let item: ItemData;
    try {
      console.log(`Calling Merc API function: ${apiFunc}`);
      item = await runLambda(apiFunc, {
        id: nextItem.orgUrl.split("/").pop(),
      });
    } catch (error) {
      console.log(`Merc API item failed. Updating function ${apiFunc}`);
      await updateFunction(apiFunc);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue; // APIコールが失敗した商品は、とりあえずスキップ
    }

    let toUpdateParams: Record<string, any> = {
      scannedAt: getFormattedDate(new Date()),
      scanCount: (nextItem.scanCount || 0) + 1,
      isOrgLive: item.status === "on_sale",
    };

    // 在庫切れの場合
    if (!toUpdateParams.isOrgLive) {
      console.log("Item is removed or sold out");
      await runLambda(LAMBDA_EBAY_DELETE, {
        account: "main",
        sku: nextItem.ebaySku,
      });
      await ddb.updateItem(
        TABLE_NAME,
        "id",
        nextItem.id,
        {
          ...toUpdateParams,
          isListed: false,
        },
        "isListedGsi"
      );
      continue;
    }

    // 在庫がある場合
    toUpdateParams = {
      ...toUpdateParams,
      orgImageUrls: item.photos,
      orgPrice: item.price,
      orgTitle: item.name,
      isTitleChanged:
        nextItem.isTitleChanged || nextItem.orgTitle !== item.name,
      isImageChanged:
        nextItem.isImageChanged ||
        nextItem.orgImageUrls.toString() !== item.photos.toString(),
    };
    console.log(JSON.stringify({ toUpdateParams }));

    const isEligibleResult: IsEligible = await runLambda(
      LAMBDA_IS_ELIGIBLE_FOR_LISTING,
      {
        item,
      }
    );
    console.log(JSON.stringify({ isEligibleResult }));

    // 在庫がある、かつ出品不可な場合
    if (
      !isEligibleResult.isEligible ||
      toUpdateParams.isImageChanged ||
      toUpdateParams.isTitleChanged ||
      !nextItem.boxSizeCm // FIXME 出品に必要な情報が揃っていない場合
    ) {
      console.log("Item is not eligible for listing or needs update");
      await runLambda(LAMBDA_EBAY_DELETE, {
        account: "main",
        sku: nextItem.ebaySku,
      });
      await ddb.updateItem(
        TABLE_NAME,
        "id",
        nextItem.id,
        {
          ...toUpdateParams,
          isListed: false,
        },
        "isListedGsi"
      );
      continue;
    }

    // 出品可能な場合
    console.log("Item is eligible for listing");
    await ddb.updateItem(TABLE_NAME, "id", nextItem.id, {
      ...toUpdateParams,
      isListed: true,
      isListedGsi: 1,
    });

    // const inventoryPayload = {
    //   availability: {
    //     shipToLocationAvailability: {
    //       quantity: 1,
    //     },
    //   },
    //   condition: nextItem.ebayCondition,
    //   product: {
    //     title: nextItem.ebayTitle,
    //     description: nextItem.ebayDescription,
    //     imageUrls: nextItem.ebayImageUrls,
    //     aspects: nextItem.ebayAspectParam,
    //   },
    //   ...(nextItem.ebayConditionDescription
    //     ? { conditionDescription: nextItem.ebayConditionDescription }
    //     : {}),
    // };

    const offerPart: OfferPart = await runLambda(LAMBDA_OFFER_PART, {
      id: item.id,
      account: "main",
      orgPrice: item.price,
      weight: nextItem.weightGram,
      box_dimensions: {
        length: nextItem.boxSizeCm[0],
        width: nextItem.boxSizeCm[1],
        height: nextItem.boxSizeCm[2],
      },
    });

    const offerPayload = {
      ...offerPart,
      sku: nextItem.ebaySku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
      categoryId: nextItem.ebayCategory,
      merchantLocationKey: "main-warehouse",
      storeCategoryNames: [nextItem.ebayStoreCategory],
    };
    console.log(JSON.stringify({ offerPayload }));

    const ebayListResult: EbayListResult = await runLambda(LAMBDA_EBAY_LIST, {
      sku: nextItem.ebaySku,
      // inventoryPayload,
      offerPayload,
      account: "main",
    });
    console.log(JSON.stringify({ ebayListResult }));
  }
}

main()
  .then(() => {
    console.log(
      JSON.stringify({
        message: "Container ended.",
      })
    );
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        message: "Container accidently ended.",
        content: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      })
    );
  });
