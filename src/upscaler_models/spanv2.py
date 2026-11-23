import torch
from torch import nn
from torch.nn import functional as F


class Conv3XC(nn.Module):
    def __init__(self, input_channels, output_channels, bias=False):
        super().__init__()
        self.conv = nn.Conv2d(input_channels, output_channels, 3, padding=1, bias=bias)

    def forward(self, value):
        return self.conv(value)


class SPABV2(nn.Module):
    def __init__(self, input_channels, middle_channels=None, output_channels=None, bias=False):
        super().__init__()
        middle_channels = middle_channels or input_channels
        output_channels = output_channels or input_channels
        self.input_channels = input_channels
        self.output_channels = output_channels
        self.c1 = Conv3XC(input_channels, middle_channels, bias=bias)
        self.c2 = Conv3XC(middle_channels, middle_channels, bias=bias)
        self.c3 = Conv3XC(middle_channels, output_channels, bias=bias)
        self.act = nn.ReLU(inplace=True)
        if input_channels == output_channels:
            self.guidance_map_conv = nn.Conv2d(output_channels, output_channels, 1, bias=True)

    def forward(self, value):
        features = self.c3(self.act(self.c2(self.act(self.c1(value)))))
        if self.input_channels == self.output_channels:
            return (value + features) * self.guidance_map_conv(features)
        return self.act(features)


class SPANV2ESR(nn.Module):
    def __init__(self, input_channels=3, output_channels=3, feature_channels=32, upscale=4, bias=False):
        super().__init__()
        scale = upscale
        self.block_1 = SPABV2(input_channels, feature_channels, feature_channels, bias=bias)
        self.block_2 = SPABV2(feature_channels, bias=bias)
        self.block_3 = SPABV2(feature_channels, bias=bias)
        self.block_4 = SPABV2(feature_channels, bias=bias)
        self.block_5 = SPABV2(feature_channels, bias=bias)
        self.conv_near = nn.Conv2d(
            input_channels,
            input_channels * scale**2,
            3,
            padding=1,
            groups=input_channels,
            bias=False,
        )
        with torch.no_grad():
            self.conv_near.weight.zero_()
            self.conv_near.weight[:, 0, 1, 1] = 1
        channels = input_channels * scale**2 + feature_channels
        self.depthwise_conv = nn.Conv2d(channels, channels, 3, padding=1, groups=channels, bias=bias)
        self.pointwise_conv = nn.Conv2d(channels, output_channels * scale**2, 1, bias=bias)
        self.depth_to_space = nn.PixelShuffle(scale)

    def forward(self, value):
        features = self.block_1(value)
        features = self.block_2(features)
        features = self.block_3(features)
        features = self.block_4(features)
        features = self.block_5(features)
        output = torch.cat((self.conv_near(value), features), dim=1)
        return self.depth_to_space(self.pointwise_conv(self.depthwise_conv(output)))
