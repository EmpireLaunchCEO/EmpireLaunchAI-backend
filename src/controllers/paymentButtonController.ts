import { Request, Response } from 'express';
import { paymentButtonService } from '../services/paymentButtonService.js';

export const createButton = async (req: Request, res: Response) => {
  try {
    const { userId, productId, platform, buttonData, buttonType } = req.body;
    const buttonId = await paymentButtonService.createButton(userId, productId, platform, buttonData, buttonType);
    res.status(201).json({ status: 'success', buttonId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getButtons = async (req: Request, res: Response) => {
  try {
    const { userId, productId } = req.query;
    let buttons;
    if (productId) {
      buttons = await paymentButtonService.getButtonsByProduct(productId as string);
    } else if (userId) {
      buttons = await paymentButtonService.getButtonsByUser(userId as string);
    } else {
      return res.status(400).json({ error: 'userId or productId is required' });
    }
    res.json({ status: 'success', buttons });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateButton = async (req: Request, res: Response) => {
  try {
    const { buttonId } = req.params;
    await paymentButtonService.updateButton(buttonId as string, req.body);
    res.json({ status: 'success' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteButton = async (req: Request, res: Response) => {
  try {
    const { buttonId } = req.params;
    await paymentButtonService.deleteButton(buttonId as string);
    res.json({ status: 'success' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
